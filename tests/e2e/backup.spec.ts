// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Backing up the radios that are read in flashing mode: the page reads the simulated
 * radio, the browser gets a zip with exactly what the radio held and a manifest that
 * describes it, a copy stays in the browser, and the backup can be flashed back.
 */
import { expect, test, type Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { choose, enter, flash, pickBuild, skipBackup, step, turnOnExperimental } from './flow.ts';

/** What the tests read from a bundle's backup.json. */
interface Manifest {
  format: string;
  radio: string;
  radioId: string | null;
  idKind: string | null;
  source: string;
  firmware?: string;
  notes: string[];
  parts: { file: string; kind: string; address?: number; size: number; complete: boolean }[];
}

/** A downloaded backup: its name, the zip, and what is inside. */
interface Downloaded {
  name: string;
  zip: Buffer;
  manifest: Manifest;
  files: Record<string, Uint8Array>;
}

/** Clicks "Back up now" and returns the bundle the browser was handed. */
async function backUp(page: Page): Promise<Downloaded> {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('backup').click()]);
  await expect(page.getByTestId('backup-done')).toBeVisible({ timeout: 45_000 });
  const zip = readFileSync(await download.path());
  const files = unzipSync(zip);
  const manifest = JSON.parse(strFromU8(files['backup.json'])) as Manifest;
  return { name: download.suggestedFilename(), zip, manifest, files };
}

/**
 * From a chosen build to the backup step. Nothing asks for experimental flashing on the
 * way: reading a radio changes nothing on it.
 */
async function toBackup(page: Page): Promise<void> {
  await enter(page);
  await expect(step(page, 'step-backup')).toHaveAttribute('data-mode', 'open');
  await expect(page.getByTestId('needs-experimental')).toHaveCount(0);
}

/** What the simulated radio held before anything was done to it. */
async function original(page: Page): Promise<Buffer> {
  return Buffer.from(await page.evaluate(() => Array.from(window.__ortxSim!.original!)));
}

/** Asks the simulated radio whether it holds `image` as a restored backup. */
async function holds(page: Page, image: Uint8Array): Promise<string[]> {
  return page.evaluate((bytes) => window.__ortxSim!.verify(Uint8Array.from(bytes), true), Array.from(image));
}

for (const radio of ['mod17', 'cs7000p']) {
  test(`${radio}: backs up, flashes, then restores the backup`, async ({ page }) => {
    await choose(page, radio);
    await toBackup(page);

    // Flashing comes after the backup step.
    await expect(step(page, 'step-flash')).toHaveAttribute('data-mode', 'waiting');
    // A Module 17 is all program memory; the CS7000 Plus has a memory chip this read leaves out.
    if (radio === 'mod17') await expect(page.getByTestId('backup-not-included')).toHaveCount(0);
    else await expect(page.getByTestId('backup-not-included')).toContainText('32 MB memory chip');
    await expect(page.getByTestId('backup-unchecked')).toHaveText('Unchecked on this model');

    const backup = await backUp(page);
    expect(backup.name).toMatch(new RegExp(`^backup_${radio}_sim0001_\\d{8}-\\d{4}\\.zip$`));
    expect(backup.manifest).toMatchObject({
      format: 'openrtx-backup/1',
      radio,
      radioId: 'SIM0001',
      idKind: 'usb-serial',
      source: 'flashing-mode',
    });
    expect(backup.manifest.parts).toHaveLength(1);
    expect(backup.manifest.parts[0]).toMatchObject({
      kind: 'internal-flash',
      address: 0x08000000,
      complete: true,
    });
    const image = backup.files[backup.manifest.parts[0].file];
    const before = await original(page);
    expect(before.length).toBe(radio === 'cs7000p' ? 2 * 1024 * 1024 : 1024 * 1024);
    expect(Buffer.compare(image, before)).toBe(0);
    await expect(page.getByTestId('backup-done')).toContainText('kept a copy in this browser');
    await expect(page.getByTestId('stored-backup')).toHaveCount(1);

    // The same radio is flashed without asking for it again.
    await page.getByTestId('backup-continue').click();
    await expect(step(page, 'step-backup')).toContainText('saved · radio …SIM0001');
    await flash(page);
    expect(await holds(page, image)).not.toEqual([]);

    // Put the backup back: from the copy the browser kept, or from the downloaded file.
    if (radio === 'mod17') {
      await page.getByTestId('stored-restore').click();
    } else {
      await page.getByTestId('open-step-firmware').click();
      await page.getByTestId('open-other').click();
      await page.getByTestId('open-local').click();
      await page
        .getByTestId('file-input')
        .setInputFiles({ name: backup.name, mimeType: 'application/zip', buffer: backup.zip });
    }
    await expect(step(page, 'step-flash')).toHaveAttribute('data-mode', 'open');
    await expect(page.getByTestId('restoring')).toBeVisible();
    await flash(page);
    expect(await holds(page, image)).toEqual([]);

    // The backup is not offered to a different model.
    await page.getByTestId('open-step-radio').click();
    await page.getByTestId('radio-cs7000').click();
    await expect(page.getByTestId('backup-not-flashable')).toContainText('not of the');
    await expect(step(page, 'step-flash')).toHaveAttribute('data-mode', 'waiting');
  });
}

test('a backup kept in the browser is listed again after a reload, and can be forgotten', async ({
  page,
}) => {
  await choose(page, 'mod17');
  await toBackup(page);
  await backUp(page);

  await page.reload();
  await pickBuild(page);
  await enter(page);
  await expect(page.getByTestId('stored-count')).toContainText('1 backup of this model in this browser');
  await expect(page.getByTestId('stored-backup')).toHaveCount(1);
  await expect(page.getByTestId('stored-backup')).toContainText('Module 17');
  await expect(page.getByTestId('stored-backup')).toContainText('SIM0001');
  // A stored backup is a reminder, not a pass: this step still asks.
  await expect(step(page, 'step-flash')).toHaveAttribute('data-mode', 'waiting');

  // Forgetting takes two clicks.
  await page.getByTestId('stored-forget').click();
  await expect(page.getByTestId('stored-backup')).toHaveCount(1);
  await page.getByTestId('stored-forget').click();
  await expect(page.getByTestId('stored-backups')).toHaveCount(0);
  await expect(page.getByTestId('stored-count')).toHaveCount(0);
});

test('a damaged backup is refused with the reason', async ({ page }) => {
  await choose(page, 'mod17');
  await toBackup(page);
  const backup = await backUp(page);
  const damaged = Buffer.from(backup.zip);
  // Stored, not compressed: a byte flipped in the middle changes the image, not the zip's structure.
  damaged[damaged.length >> 1] ^= 0xff;
  await page.getByTestId('open-step-firmware').click();
  await page.getByTestId('open-other').click();
  await page.getByTestId('open-local').click();
  await page
    .getByTestId('file-input')
    .setInputFiles({ name: backup.name, mimeType: 'application/zip', buffer: damaged });
  await expect(page.getByTestId('file-error')).toContainText('This backup is damaged');
});

test('c62: backs up through cskburn, then asks for flashing mode again', async ({ page }) => {
  await page.goto('?sim=1#c62');
  await page.getByTestId('open-other').click();
  await page.getByTestId('open-local').click();
  await page.getByTestId('file-input').setInputFiles({
    name: 'zephyr.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(8192, 7),
  });
  await expect(page.getByTestId('enter-again')).toHaveCount(0);
  // The C62 has been checked on a real radio, so nothing asks for experimental flashing.
  await enter(page);
  await expect(page.getByTestId('needs-experimental')).toHaveCount(0);

  const backup = await backUp(page);
  expect(backup.name).toMatch(/^backup_c62_00065701_\d{8}-\d{4}\.zip$/);
  expect(backup.manifest).toMatchObject({
    radioId: 'C620240900065701',
    idKind: 'chip-id',
    source: 'flashing-mode',
  });
  expect(Buffer.compare(backup.files['flash.bin'], await original(page))).toBe(0);

  // Reading ended flashing mode: the page sends the user back to that step, once.
  await page.getByTestId('backup-continue').click();
  await expect(page.getByTestId('enter-again')).toBeVisible();
  await expect(step(page, 'step-flash')).toHaveAttribute('data-mode', 'waiting');
  await enter(page);
  await flash(page);
});

test('a read-protected radio cannot be backed up, and the step can be skipped', async ({ page }) => {
  await choose(page, 'mod17', 'protected');
  await toBackup(page);
  await page.getByTestId('backup').click();
  await expect(page.getByTestId('backup-error')).toContainText('read-protected');
  await expect(step(page, 'step-flash')).toHaveAttribute('data-mode', 'waiting');
  await skipBackup(page);
  await turnOnExperimental(page);
  await expect(page.getByTestId('flash')).toBeEnabled();
});

test('skipping the backup is remembered for that radio only', async ({ page }) => {
  await choose(page, 'mod17');
  await enter(page);
  await skipBackup(page);
  await expect(step(page, 'step-backup')).toContainText('skipped');
  await expect(step(page, 'step-flash')).toHaveAttribute('data-mode', 'open');

  await page.getByTestId('open-step-radio').click();
  await page.getByTestId('radio-cs7000').click();
  await expect(step(page, 'step-enter')).toHaveAttribute('data-mode', 'open');
  await expect(step(page, 'step-backup')).not.toContainText('skipped');
  await expect(step(page, 'step-flash')).toHaveAttribute('data-mode', 'waiting');
});

test('the T-TWR Plus is backed up by copying a file', async ({ page }) => {
  await choose(page, 'ttwrplus');
  await enter(page);
  await expect(page.getByTestId('backup-copy')).toContainText('CURRENT.UF2');
  await expect(page.getByTestId('backup-copy')).toContainText('It is the firmware only');
  await page.getByTestId('backup-continue').click();
  await expect(step(page, 'step-backup')).toContainText('done');
  await expect(step(page, 'step-flash')).toHaveAttribute('data-mode', 'open');
});

test('a browser that cannot read the radio gets the command for the usual tool', async ({ page }) => {
  await page.addInitScript(() => {
    for (const api of ['usb', 'serial', 'hid'])
      delete (Navigator.prototype as unknown as Record<string, unknown>)[api];
  });
  await page.goto('#mod17');
  await pickBuild(page);
  await enter(page);
  await expect(page.getByTestId('backup-needs-browser')).toContainText(
    'dfu-util -d 0483:df11 -a 0 -s 0x08000000:1048576 -U backup.bin',
  );
  await expect(page.getByTestId('backup')).toHaveCount(0);
  await skipBackup(page);
  await expect(page.getByTestId('unsupported')).toBeVisible();
});
