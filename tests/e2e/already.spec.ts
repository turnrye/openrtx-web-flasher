// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A radio this browser already holds a backup of is not read again. The backup step
 * starts by finding out which radio it is talking to; when its ID matches a stored,
 * complete backup, the read stops there and the page says so. That holds where the ID
 * is known to be the radio's own; the others are read each time.
 */
import { expect, test, type Page } from '@playwright/test';
import { enter, flash, pickBuild, step, turnOnExperimental } from './flow.ts';

/** Takes a backup and waits for the file. */
async function backUp(page: Page): Promise<void> {
  await Promise.all([page.waitForEvent('download'), page.getByTestId('backup').click()]);
  await expect(page.getByTestId('backup-done')).toBeVisible({ timeout: 60_000 });
}

/** Clicks the backup button and expects the page to recognise the radio without saving a new file. */
async function expectRecognised(page: Page, id: RegExp): Promise<void> {
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.getByTestId('backup').click();
  await expect(page.getByTestId('backup-already')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('backup-already')).toContainText('was already backed up in this browser');
  await expect(page.getByTestId('backup-already')).toContainText(id);
  expect(downloads).toBe(0);
}

/** Puts a zephyr.bin on the C62 page as the firmware. */
async function chooseC62(page: Page): Promise<void> {
  await page.goto('?sim=1#c62');
  await page.getByTestId('open-other').click();
  await page.getByTestId('open-local').click();
  await page.getByTestId('file-input').setInputFiles({
    name: 'zephyr.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(8192, 7),
  });
}

test('c62: the second time, the chip ID is enough and the ten-minute read is not repeated', async ({
  page,
}) => {
  await chooseC62(page);
  await enter(page);
  await backUp(page);

  await page.reload();
  await chooseC62(page);
  await enter(page);
  await expect(page.getByTestId('stored-count')).toContainText('does not read one it already has again');
  await expectRecognised(page, /…00065701/);
  // What the radio said is still there to look at.
  const backup = step(page, 'step-backup');
  await backup.getByTestId('console').locator('summary').click();
  await expect(backup.getByTestId('log')).toContainText('already has a backup');
  await expect(backup.getByTestId('log')).not.toContainText('Reading region');

  // Finding out which radio it is ended flashing mode, as a full read would have.
  await page.getByTestId('backup-continue').click();
  await expect(backup).toContainText('already backed up · radio …00065701');
  await expect(page.getByTestId('enter-again')).toContainText('Reading the radio ended flashing mode');
  await enter(page);
  await flash(page);
});

test('c62: a new backup can still be taken on request', async ({ page }) => {
  await chooseC62(page);
  await enter(page);
  await backUp(page);
  await page.reload();
  await chooseC62(page);
  await enter(page);
  await expectRecognised(page, /…00065701/);

  await expect(page.getByTestId('backup')).toHaveText('Back up again anyway');
  await backUp(page);
  await expect(page.getByTestId('backup-already')).toHaveCount(0);
  // Taken in the same minute, the new backup has the same name and replaces the stored copy.
  await expect(page.getByTestId('stored-backup').first()).toBeVisible();
});

test('md9600: recognised from its info blocks, without the long read or a restart', async ({ page }) => {
  await page.goto('?sim=1#md9600');
  await pickBuild(page);
  await turnOnExperimental(page, 'step-backup');
  await backUp(page);

  await page.reload();
  await pickBuild(page);
  await expectRecognised(page, /…[0-9a-f]{8}/);
  // The simulated radio was never put in the mode the long read needs, and nothing was written.
  expect(await page.evaluate(() => window.__ortxSimStock!.reads!())).toBe(0);
  expect(await page.evaluate(() => window.__ortxSimStock!.forbidden())).toEqual([]);
  await page.getByTestId('backup-continue').click();
  await expect(step(page, 'step-enter')).toHaveAttribute('data-mode', 'open');
  await expect(page.getByTestId('enter-again')).toHaveCount(0);
});

test('rt4d: its ID is a fingerprint not known to be its own, so it is read each time', async ({ page }) => {
  await page.goto('?sim=1#rt4d');
  await pickBuild(page);
  await turnOnExperimental(page, 'step-backup');
  await backUp(page);

  await page.reload();
  await pickBuild(page);
  await backUp(page);
  await expect(page.getByTestId('backup-already')).toHaveCount(0);
  // More than the four blocks the fingerprint is taken from: the whole read.
  expect(await page.evaluate(() => window.__ortxSimStock!.reads!())).toBeGreaterThan(4);
});

test('mod17: recognised by its USB serial number before anything is read', async ({ page }) => {
  await page.goto('?sim=1#mod17');
  await pickBuild(page);
  await enter(page);
  await turnOnExperimental(page, 'step-backup');
  await backUp(page);

  await page.reload();
  await pickBuild(page);
  await enter(page);
  await expectRecognised(page, /…SIM0001/);
  await page.getByTestId('backup-continue').click();
  await expect(step(page, 'step-flash')).toHaveAttribute('data-mode', 'open');
});

test('gd77: its ID only comes at the end of a short read, so it is read each time', async ({ page }) => {
  await page.goto('?sim=1#gd77');
  await pickBuild(page);
  await turnOnExperimental(page, 'step-backup');
  await backUp(page);

  await page.reload();
  await pickBuild(page);
  await expect(page.getByTestId('stored-count')).not.toContainText('does not read one it already has again');
  await backUp(page);
  await expect(page.getByTestId('backup-already')).toHaveCount(0);
});

test('a forgotten backup no longer counts', async ({ page }) => {
  await page.goto('?sim=1#mod17');
  await pickBuild(page);
  await enter(page);
  await turnOnExperimental(page, 'step-backup');
  await backUp(page);
  await page.getByTestId('stored-forget').click();
  await page.getByTestId('stored-forget').click();
  await expect(page.getByTestId('stored-backups')).toHaveCount(0);

  await page.reload();
  await pickBuild(page);
  await enter(page);
  await backUp(page);
  await expect(page.getByTestId('backup-already')).toHaveCount(0);
});
