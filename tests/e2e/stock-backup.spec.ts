// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Backing up the radios whose bootloader cannot be read: the page reads them through
 * their original firmware, in normal mode, before they go into flashing mode. The
 * simulated radio lists every request that could have changed it; that list must stay
 * empty, and what the backup holds must be what the radio holds.
 */
import { expect, test, type Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  answerRuns,
  choose,
  enter,
  flash,
  openStep,
  pickRadio,
  skipBackup,
  step,
  turnOnExperimental,
} from './flow.ts';

/** One part as backup.json describes it. */
interface Part {
  file: string;
  kind: 'internal-flash' | 'spi-flash' | 'eeprom' | 'info';
  address?: number;
  size: number;
  complete: boolean;
}

/** What the tests read from backup.json. */
interface Manifest {
  radio: string;
  radioId: string | null;
  source: string;
  firmware?: string;
  notes: string[];
  parts: Part[];
}

/** A downloaded backup. */
interface Downloaded {
  name: string;
  zip: Buffer;
  manifest: Manifest;
  files: Record<string, Uint8Array>;
}

/**
 * Opens the page on a radio with a build chosen, at the backup step, and says the radio
 * still runs its original firmware. Nothing asks for experimental flashing: the read
 * changes nothing on the radio.
 */
async function toBackup(page: Page, radio: string, sim = '1'): Promise<void> {
  await choose(page, radio, sim);
  // The backup is taken in normal mode, so it comes before flashing mode.
  expect(await openStep(page)).toBe('step-backup');
  await expect(page.getByTestId('needs-experimental')).toHaveCount(0);
  await answerRuns(page, 'original');
}

/** Clicks the backup button and returns the bundle the browser was handed. */
async function backUp(page: Page): Promise<Downloaded> {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('backup').click()]);
  await expect(page.getByTestId('backup-done')).toBeVisible({ timeout: 60_000 });
  const zip = readFileSync(await download.path());
  const files = unzipSync(zip);
  return {
    name: download.suggestedFilename(),
    zip,
    manifest: JSON.parse(strFromU8(files['backup.json'])) as Manifest,
    files,
  };
}

/** SHA-256 of what the simulated radio holds where `part` was read from. */
async function radioDigest(page: Page, part: Part): Promise<string> {
  return page.evaluate(async ({ kind, address, size }) => {
    if (kind === 'info') throw new Error('info blocks are not a memory region');
    const bytes = window.__ortxSimStock!.region(kind, address ?? 0, size);
    const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }, part);
}

/** Checks every memory part of a backup against the simulated radio, and that nothing was written. */
async function expectFaithful(page: Page, backup: Downloaded): Promise<void> {
  const memory = backup.manifest.parts.filter((part) => part.kind !== 'info');
  expect(memory.length).toBeGreaterThan(0);
  for (const part of memory) {
    const got = createHash('sha256').update(backup.files[part.file]).digest('hex');
    expect(got, part.file).toBe(await radioDigest(page, part));
    expect(part.complete, part.file).toBe(true);
  }
  expect(await page.evaluate(() => window.__ortxSimStock!.forbidden())).toEqual([]);
  // A radio with an ID of its own must be recorded under it; the others get a fingerprint.
  const id = await page.evaluate(() => window.__ortxSimStock!.id);
  if (id) expect(backup.manifest.radioId).toBe(id);
  else expect(backup.manifest.radioId).toMatch(/^[0-9a-f]{16,}$/);
}

test('md9600: the backup comes first, reads the original firmware, then the radio is flashed', async ({
  page,
}) => {
  await toBackup(page, 'md9600');
  await expect(step(page, 'step-backup')).toContainText('Put the radio in normal mode');
  await expect(step(page, 'step-enter')).toHaveAttribute('data-mode', 'waiting');
  // The page reads everything; there is nothing to choose.
  await expect(step(page, 'step-backup').locator('input[type="radio"]')).toHaveCount(0);
  // The read was measured on this model with other tools, never from the page.
  await expect(page.getByTestId('backup-unchecked')).toHaveText('Unchecked on this model');
  // Before the read the page says what the backup will not hold.
  await expect(page.getByTestId('backup-not-included')).toContainText('security registers');
  await expect(page.getByTestId('backup-not-included').locator('a')).toHaveAttribute(
    'href',
    /\/flash\/backups\/#md9600$/,
  );

  const backup = await backUp(page);
  expect(backup.name).toMatch(/^backup_md9600_[0-9a-f]{8}_\d{8}-\d{4}\.zip$/);
  expect(backup.manifest).toMatchObject({
    radio: 'md9600',
    source: 'original-firmware',
    firmware: 'V006.009',
  });
  const files = backup.manifest.parts.map((part) => part.file);
  expect(files).toContain('info-07.bin');
  expect(files).toContain('bootloader-65535.bin');
  const spi = backup.manifest.parts.find((part) => part.file === 'spi-flash.bin');
  expect(spi).toMatchObject({ kind: 'spi-flash', address: 0, size: 16 * 1024 * 1024, complete: true });
  await expectFaithful(page, backup);

  // The browser keeps it as a record: there is nothing to restore from it.
  await expect(page.getByTestId('stored-backup')).toHaveCount(1);
  await expect(page.getByTestId('stored-restore')).toHaveCount(0);
  await expect(page.getByTestId('backup-done')).toContainText('restarts by itself');

  // Flashing asks for the radio again: in flashing mode it is another device.
  await page.getByTestId('backup-continue').click();
  await enter(page);
  await flash(page);
  expect(await page.evaluate(() => window.__ortxSim!.radioId)).toBe('md9600');

  // Offered as firmware, the backup is explained, not flashed.
  await page.getByTestId('open-step-firmware').click();
  await page.getByTestId('open-other').click();
  await page.getByTestId('open-local').click();
  await page
    .getByTestId('file-input')
    .setInputFiles({ name: backup.name, mimeType: 'application/zip', buffer: backup.zip });
  await expect(page.getByTestId('backup-not-flashable')).toContainText('cannot write it back');
  await expect(step(page, 'step-flash')).toHaveAttribute('data-mode', 'waiting');
});

test('mduv3x0: says once, before the read, that the method is unchecked on this model', async ({ page }) => {
  await toBackup(page, 'mduv3x0');
  await expect(page.getByTestId('backup-unchecked')).toHaveText('Unchecked on this model');

  const backup = await backUp(page);
  await expectFaithful(page, backup);
  // The backup itself keeps the caveat; the result on the page does not repeat it.
  expect(backup.manifest.notes.join(' ')).toMatch(/MD-9600 only/);
  await expect(page.getByTestId('backup-done')).not.toContainText('MD-9600');
  await expect(page.getByTestId('backup-notes')).toBeHidden();
  await page.getByTestId('backup-about').locator('summary').click();
  await expect(page.getByTestId('backup-about')).toContainText('not of everything in it');
  await expect(page.getByTestId('backup-notes')).toContainText('MD-9600 only');
});

test('a TYT radio in the wrong state is told so, for the backup and for flashing', async ({ page }) => {
  await toBackup(page, 'md3x0', 'wrongmode');

  // In flashing mode the original firmware is not there to be read.
  await page.getByTestId('backup').click();
  await expect(page.getByTestId('backup-error')).toContainText('The radio is in flashing mode');
  await expect(page.getByTestId('backup-error')).toContainText('normal mode');
  expect(await page.evaluate(() => window.__ortxSimStock!.forbidden())).toEqual([]);
  await expect(step(page, 'step-enter')).toHaveAttribute('data-mode', 'waiting');

  // In normal mode it must not be flashed: nothing is sent.
  await skipBackup(page);
  await enter(page);
  await turnOnExperimental(page);
  await page.getByTestId('flash').click();
  await expect(page.getByTestId('flash-error')).toContainText('not in flashing mode');
});

for (const radio of ['gd77', 'dm1801']) {
  test(`${radio}: reads channels, settings and calibration through the original firmware`, async ({
    page,
  }) => {
    await toBackup(page, radio);
    const backup = await backUp(page);
    expect(backup.manifest).toMatchObject({ radio, source: 'original-firmware' });
    const files = backup.manifest.parts.map((part) => part.file);
    expect(files).toEqual(
      expect.arrayContaining([
        'codeplug-00080.bin',
        'codeplug-08000.bin',
        'codeplug-10000.bin',
        'calibration.bin',
      ]),
    );
    await expectFaithful(page, backup);

    await page.getByTestId('backup-continue').click();
    await enter(page);
    await flash(page);
  });
}

test('rt4d: reads the whole 16 MB memory chip, and the same radio gets the same ID twice', async ({
  page,
}) => {
  await toBackup(page, 'rt4d');
  await expect(step(page, 'step-backup')).toContainText('about half an hour');
  await expect(page.getByTestId('backup-not-included')).toContainText(
    'program memory (256 KB) cannot be read',
  );
  const first = await backUp(page);
  expect(first.manifest.parts).toHaveLength(1);
  expect(first.manifest.parts[0]).toMatchObject({
    kind: 'spi-flash',
    address: 0,
    size: 16 * 1024 * 1024,
    complete: true,
  });
  await expectFaithful(page, first);

  const second = await backUp(page);
  await expectFaithful(page, second);
  expect(second.manifest.radioId).toBe(first.manifest.radioId);

  await page.getByTestId('backup-continue').click();
  await enter(page);
  await flash(page);
});

/** Opens the page on the RT-950 Pro with a made-up .BTF loaded, at the backup step. */
async function toRt950Backup(page: Page, sim = '1'): Promise<void> {
  const btf = Buffer.alloc(8 * 1024, 0x3c);
  btf.write('RT-950      ', 0x3e0, 'latin1');
  await page.goto(`?sim=${sim}`);
  await pickRadio(page, 'rt950pro');
  await page.getByTestId('open-other').click();
  await page.getByTestId('open-local').click();
  await page
    .getByTestId('file-input')
    .setInputFiles({ name: 'openrtx_rt950pro.BTF', mimeType: 'application/octet-stream', buffer: btf });
  await expect(step(page, 'step-firmware')).toHaveAttribute('data-mode', 'folded');
  // The backup is taken in normal mode, so it comes before flashing mode.
  expect(await openStep(page)).toBe('step-backup');
  await answerRuns(page, 'original');
}

test('rt950pro: reads the 64 KB the programming cable reaches, then the radio is flashed', async ({
  page,
}) => {
  await toRt950Backup(page);
  await expect(page.getByTestId('backup-unchecked')).toBeVisible();
  const first = await backUp(page);
  expect(first.manifest.parts).toHaveLength(1);
  expect(first.manifest.parts[0]).toMatchObject({ kind: 'spi-flash', address: 0, size: 64 * 1024 });
  expect(first.manifest.source).toBe('original-firmware');
  expect(first.manifest.notes.join(' ')).toContain('radtels.com/pages/software-download');
  await expectFaithful(page, first);

  const second = await backUp(page);
  await expectFaithful(page, second);
  expect(second.manifest.radioId).toBe(first.manifest.radioId);

  await page.getByTestId('backup-continue').click();
  await enter(page);
  await flash(page);
});

test('an RT-950 Pro in flashing mode gives no backup and sends the user nowhere', async ({ page }) => {
  await toRt950Backup(page, 'wrongmode');
  await page.getByTestId('backup').click();
  await expect(page.getByTestId('backup-error')).toContainText('normal mode, not flashing mode', {
    timeout: 30_000,
  });
  expect(await page.evaluate(() => window.__ortxSimStock!.forbidden())).toEqual([]);
  await expect(step(page, 'step-enter')).toHaveAttribute('data-mode', 'waiting');
});

test('an RT-4D in flashing mode is not mistaken for one in normal mode', async ({ page }) => {
  await toBackup(page, 'rt4d', 'wrongmode');
  await page.getByTestId('backup').click();
  await expect(page.getByTestId('backup-error')).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => window.__ortxSimStock!.forbidden())).toEqual([]);
  await expect(step(page, 'step-enter')).toHaveAttribute('data-mode', 'waiting');
});
