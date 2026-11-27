// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Steps of the page that most browser tests walk through, as a user would. The tests'
 * addresses are relative to the flasher's page (playwright.config.ts): '' is the
 * flasher, '../' the site's home page.
 */
import { expect, type Locator, type Page } from '@playwright/test';

/** The steps after the firmware is chosen, by the id of their section. */
export type StepId = 'step-backup' | 'step-enter' | 'step-flash';

/** One step's section. */
export function step(page: Page, id: StepId | 'step-radio' | 'step-firmware'): Locator {
  return page.locator(`#${id}`);
}

/** The id of the step that is open now. */
export async function openStep(page: Page): Promise<string> {
  const open = page.locator('[data-testid="step"][data-mode="open"]');
  await expect(open).toHaveCount(1);
  return (await open.getAttribute('id'))!;
}

/** The cards of the radio picker, in both of its groups. */
export function radioCards(page: Page): Locator {
  return page.getByTestId('radios').locator('button');
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

/**
 * Answers "What does the radio run now?", which the backup step asks for the radios it
 * reads through their original firmware.
 */
export async function answerRuns(page: Page, runs: 'original' | 'openrtx'): Promise<void> {
  const answer = step(page, 'step-backup').getByTestId(`runs-${runs}`);
  await answer.click();
  await expect(answer).toHaveAttribute('aria-pressed', 'true');
}

/** Turns experimental flashing on in the flash step, the only step that asks for it. */
export async function turnOnExperimental(page: Page): Promise<void> {
  const flashStep = step(page, 'step-flash');
  await flashStep.getByTestId('turn-on-experimental').click();
  await expect(flashStep.getByTestId('needs-experimental')).toHaveCount(0);
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
  // A radio read through its original firmware is asked what it runs before anything else.
  const original = backup.getByTestId('runs-original');
  if ((await original.count()) > 0 && (await original.getAttribute('aria-pressed')) !== 'true') {
    await answerRuns(page, 'original');
  }
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
  if (experimental && (await gate.count()) > 0) await turnOnExperimental(page);
}

/**
 * Clicks Flash and waits until the page says it is done. A radio nobody has checked on
 * hardware asks for experimental flashing first; that is turned on here.
 */
export async function flash(page: Page): Promise<void> {
  const flashStep = step(page, 'step-flash');
  const gate = flashStep.getByTestId('turn-on-experimental');
  await expect(flashStep.getByTestId('flash').or(gate)).toBeVisible();
  if ((await gate.count()) > 0) await turnOnExperimental(page);
  await flashStep.getByTestId('flash').click();
  await expect(page.getByTestId('done')).toBeVisible({ timeout: 45_000 });
}
