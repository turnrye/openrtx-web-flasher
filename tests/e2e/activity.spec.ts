// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What the page shows while it talks to a radio. `?sim=slow` gives simulated radios that
 * take a few milliseconds over every request, so a read or a flash lasts long enough to
 * look at.
 */
import { expect, test } from '@playwright/test';
import { enter, pickBuild, skipBackup, step, turnOnExperimental } from './flow.ts';

test('a backup shows that it is busy, how far along it is, and a console that fills in live', async ({
  page,
}) => {
  await page.goto('?sim=slow#c62');
  await page.getByTestId('open-other').click();
  await page.getByTestId('open-local').click();
  await page.getByTestId('file-input').setInputFiles({
    name: 'zephyr.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(8192, 7),
  });
  await enter(page);
  const backup = step(page, 'step-backup');
  await expect(backup.getByTestId('console')).toHaveCount(0);

  await page.getByTestId('backup').click();
  // Busy at once, before the radio has given any progress.
  await expect(page.getByTestId('backup').locator('.spinner')).toBeVisible();
  await expect(backup.getByTestId('meter')).toHaveClass(/active/);
  await expect(backup.getByTestId('activity')).toContainText('elapsed');

  // Then amounts, not only a percentage, and the radio's last message.
  await expect(backup.getByTestId('activity')).toContainText(/Reading · \d+ KB of 64 KB · \d:\d\d elapsed/);
  await expect(backup.getByTestId('activity-last')).toContainText('Reading region');

  // The console can be opened while the read runs.
  await backup.getByTestId('console').locator('summary').click();
  await expect(backup.getByTestId('log')).toContainText('Entering update mode');
  await expect(backup.getByTestId('log')).toContainText('Detected flash size');

  await expect(page.getByTestId('backup-done')).toBeVisible({ timeout: 60_000 });
  // Afterwards the status line is gone, the bar is still, and the console stays.
  await expect(backup.getByTestId('activity')).toHaveCount(0);
  await expect(page.getByTestId('backup').locator('.spinner')).toHaveCount(0);
  await expect(backup.getByTestId('meter')).not.toHaveClass(/active/);
  await expect(backup.getByTestId('console')).toContainText(/Console \(\d+ lines\)/);
});

test('a flash shows each stage as it happens, and keeps its console', async ({ page }) => {
  await page.goto('?sim=slow#mod17');
  await pickBuild(page);
  await enter(page);
  await skipBackup(page);
  const flash = step(page, 'step-flash');
  await turnOnExperimental(page, 'step-flash');

  await page.getByTestId('flash').click();
  await expect(page.getByTestId('flash').locator('.spinner')).toBeVisible();
  await expect(flash.getByTestId('activity')).toContainText('elapsed');
  await expect(flash.getByTestId('activity')).toContainText(/Writing · [\d.]+ (KB|MB) of [\d.]+ (KB|MB)/, {
    timeout: 30_000,
  });
  await expect(flash.getByTestId('meter')).toHaveClass(/active/);

  await expect(page.getByTestId('done')).toBeVisible({ timeout: 60_000 });
  await expect(flash.getByTestId('activity')).toHaveCount(0);
  await expect(flash.getByTestId('percent')).toHaveText('100%');
  await flash.getByTestId('console').locator('summary').click();
  await expect(flash.getByTestId('log')).toContainText('Finished.');
});

test('a failed flash keeps its console, so what happened can be seen', async ({ page }) => {
  await page.goto('?sim=fail#mod17');
  await pickBuild(page);
  await enter(page);
  await skipBackup(page);
  await turnOnExperimental(page, 'step-flash');
  const flash = step(page, 'step-flash');
  await page.getByTestId('flash').click();
  await expect(page.getByTestId('flash-error')).toBeVisible();
  await expect(flash.getByTestId('meter')).toHaveClass(/error/);
  await expect(flash.getByTestId('meter')).not.toHaveClass(/active/);
  await flash.getByTestId('console').locator('summary').click();
  await expect(flash.getByTestId('log')).toContainText('Failed:');
});
