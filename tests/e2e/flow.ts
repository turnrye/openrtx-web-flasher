// SPDX-License-Identifier: GPL-3.0-or-later
/** Steps of the page that most browser tests walk through, as a user would. */
import { expect, type Locator, type Page } from '@playwright/test';

/** The steps after the firmware is chosen, by the id of their section. */
export type StepId = 'step-backup' | 'step-enter' | 'step-flash';

/** One step's section. */
export function step(page: Page, id: StepId | 'step-radio' | 'step-firmware'): Locator {
  return page.locator(`#${id}`);
}

/** The id of the step that is open now. The list of stored backups is not a step. */
export async function openStep(page: Page): Promise<string> {
  const open = page.locator('.step[data-mode="open"]:not(#backups)');
  await expect(open).toHaveCount(1);
  return (await open.getAttribute('id'))!;
}

/** Picks a radio from the list, unfolding "No release yet" when the radio is in there. */
export async function pickRadio(page: Page, radio: string): Promise<void> {
  const card = page.getByTestId(`radio-${radio}`);
  await card.waitFor({ state: 'attached' });
  if (!(await card.isVisible())) await page.getByTestId('no-release').locator('summary').click();
  await card.click();
}

/** Opens the page on a radio with simulated devices and picks the first build that has a file for it. */
export async function choose(page: Page, radio: string, sim = '1'): Promise<void> {
  await page.goto(`?sim=${sim}#${radio}`);
  await pickBuild(page);
}

/** Picks the first build that has a file for the chosen radio. */
export async function pickBuild(page: Page): Promise<void> {
  // Only the tiles of the firmware step: other parts of the page have ids that start the same way.
  await step(page, 'step-firmware').locator('[data-testid^="build-"]:not([disabled])').first().click();
  await expect(step(page, 'step-firmware')).toHaveAttribute('data-mode', 'folded');
}

/** Turns experimental flashing on in the step that asks for it. */
export async function turnOnExperimental(page: Page, id: StepId): Promise<void> {
  await step(page, id).getByTestId('turn-on-experimental').click();
  await expect(step(page, id).getByTestId('needs-experimental')).toHaveCount(0);
}

/** Says the radio is in flashing mode. */
export async function enter(page: Page): Promise<void> {
  await expect(step(page, 'step-enter')).toHaveAttribute('data-mode', 'open');
  await step(page, 'step-enter').getByTestId('entered').click();
}

/** Leaves the backup step without a backup from the page. */
export async function skipBackup(page: Page): Promise<void> {
  const backup = step(page, 'step-backup');
  await expect(backup).toHaveAttribute('data-mode', 'open');
  const skip = backup.getByTestId('backup-skip');
  await ((await skip.count()) > 0 ? skip : backup.getByTestId('backup-continue')).click();
}

/**
 * From a chosen build to the open Flash step, without a backup: the steps come in the
 * order they happen for the radio. Turns experimental flashing on there unless told not to.
 */
export async function skipToFlash(page: Page, experimental = true): Promise<void> {
  // A file that was just picked or dropped is read first; the step folds once it is in.
  await expect(step(page, 'step-firmware')).toHaveAttribute('data-mode', 'folded');
  for (let i = 0; i < 3; i++) {
    const open = await openStep(page);
    if (open === 'step-flash') break;
    if (open === 'step-backup') await skipBackup(page);
    else await enter(page);
  }
  await expect(step(page, 'step-flash')).toHaveAttribute('data-mode', 'open');
  const gate = step(page, 'step-flash').getByTestId('turn-on-experimental');
  if (experimental && (await gate.count()) > 0) await turnOnExperimental(page, 'step-flash');
}

/** Clicks Flash and waits until the page says it is done. */
export async function flash(page: Page): Promise<void> {
  await page.getByTestId('flash').click();
  await expect(page.getByTestId('done')).toBeVisible({ timeout: 45_000 });
}
