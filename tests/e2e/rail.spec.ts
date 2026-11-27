// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The radio picker's filters and the progress rail beside the steps: what each narrows
 * or shows, and that the rail opens a step the same way its own bar does.
 */
import { expect, test, type Page } from '@playwright/test';
import { openStep, pickBuild, pickRadio, radioCards } from './flow.ts';

/** The ids of the cards the picker shows now, in both of its groups. */
async function shownRadios(page: Page): Promise<string[]> {
  const ids = await radioCards(page).evaluateAll((cards) => cards.map((c) => c.getAttribute('data-testid')!));
  return ids.map((id) => id.replace(/^radio-/, '')).sort();
}

/** The rail's steps in the order it lists them, and how far each has got. */
async function railSteps(page: Page): Promise<string[]> {
  return page
    .getByTestId('rail')
    .locator('li')
    .evaluateAll((items) =>
      items.map(
        (li) => `${li.getAttribute('data-testid')!.replace(/^rail-/, '')}:${li.getAttribute('data-status')}`,
      ),
    );
}

test('a maker narrows both groups of radios, and opens the folded one when it holds a match', async ({
  page,
}) => {
  await page.goto('?sim=1');
  await expect(radioCards(page)).toHaveCount(13);
  await expect(page.getByTestId('maker-all')).toHaveAttribute('aria-pressed', 'true');

  await page.getByTestId('maker-tytera').click();
  await expect(page.getByTestId('maker-tytera')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('maker-all')).toHaveAttribute('aria-pressed', 'false');
  // Two in the release, the MD-9600 without one: its group opens by itself.
  expect(await shownRadios(page)).toEqual(['md3x0', 'md9600', 'mduv3x0']);
  const group = page.getByTestId('no-release');
  await expect(group).toHaveAttribute('open', '');
  await expect(group.locator('summary')).toHaveText('No release yet (1)');
  await expect(page.getByTestId('radio-md9600')).toBeVisible();

  // A maker with radios in the release only: the folded group goes.
  await page.getByTestId('maker-baofeng').click();
  expect(await shownRadios(page)).toEqual(['dm1701', 'dm1801']);
  await expect(group).toHaveCount(0);

  await page.getByTestId('maker-all').click();
  await expect(radioCards(page)).toHaveCount(13);
});

test('"checked only" keeps the radios checked on a real radio, in both groups', async ({ page }) => {
  await page.goto('?sim=1');
  await page.getByTestId('checked-only').check();
  // docs/verification.md: these four, the C62 among the radios without a release.
  expect(await shownRadios(page)).toEqual(['c62', 'cs7000', 'dm1701', 'mduv3x0']);
  await expect(radioCards(page).locator('[data-checked="no"]')).toHaveCount(0);
  await expect(page.getByTestId('no-release').locator('summary')).toHaveText('No release yet (1)');
  await page.getByTestId('checked-only').uncheck();
  await expect(radioCards(page)).toHaveCount(13);
});

test('when nothing matches, the picker says so and one click shows every radio again', async ({ page }) => {
  await page.goto('?sim=1');
  await page.getByTestId('maker-radtel').click();
  await page.getByTestId('checked-only').check();
  await expect(radioCards(page)).toHaveCount(0);
  await expect(page.getByTestId('no-match')).toContainText('No radio matches.');

  await page.getByTestId('show-all').click();
  await expect(page.getByTestId('no-match')).toHaveCount(0);
  await expect(radioCards(page)).toHaveCount(13);
  await expect(page.getByTestId('checked-only')).not.toBeChecked();
  await expect(page.getByTestId('maker-all')).toHaveAttribute('aria-pressed', 'true');
});

test('the rail follows the steps in the order they happen, and opens a step that is done', async ({
  page,
}) => {
  await page.goto('?sim=1');
  await expect(page.getByTestId('rail')).toBeVisible();
  await expect(page.getByTestId('rail-compact')).toBeHidden();
  expect(await railSteps(page)).toEqual([
    'radio:current',
    'firmware:upcoming',
    'backup:upcoming',
    'enter:upcoming',
    'flash:upcoming',
  ]);
  // Upcoming steps cannot be opened from the rail.
  await expect(page.getByTestId('rail-firmware').locator('button')).toHaveCount(0);

  // The MD-UV380 is backed up through its original firmware, before flashing mode.
  await pickRadio(page, 'mduv3x0');
  await pickBuild(page);
  expect(await railSteps(page)).toEqual([
    'radio:done',
    'firmware:done',
    'backup:current',
    'enter:upcoming',
    'flash:upcoming',
  ]);
  await expect(page.getByTestId('rail-backup')).toHaveAttribute('aria-current', 'step');

  // A done step opens again, as from its own bar.
  await page.getByTestId('rail-radio').getByRole('button', { name: 'Radio' }).click();
  expect(await openStep(page)).toBe('step-radio');
  await expect(page.getByTestId('rail-radio')).toHaveAttribute('data-status', 'current');
  await expect(page.getByTestId('rail-firmware')).toHaveAttribute('data-status', 'done');

  // The C62 is backed up in flashing mode: the rail lists that step first.
  await pickRadio(page, 'c62');
  expect((await railSteps(page)).map((s) => s.split(':')[0])).toEqual([
    'radio',
    'firmware',
    'enter',
    'backup',
    'flash',
  ]);
});

test('on a phone the rail is one line above the steps', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('?sim=1#mduv3x0');
  await expect(page.getByTestId('rail')).toBeHidden();
  const line = page.getByTestId('rail-compact');
  await expect(line).toHaveText('Step 2 of 5 · Firmware');
  await pickBuild(page);
  await expect(line).toHaveText('Step 3 of 5 · Back up');
  // It sits above the first step.
  const lineBox = (await line.boundingBox())!;
  const firstStep = (await page.locator('#step-radio').boundingBox())!;
  expect(lineBox.y).toBeLessThan(firstStep.y);
});
