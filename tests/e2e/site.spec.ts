// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The flasher's own pages: the ones written from its data, the header and footer every
 * page has, and what the backup step says a backup will not hold. The tests' base
 * address is the site's top, where the flasher is.
 */
import { expect, test } from '@playwright/test';
import { answerRuns, pickBuild, step } from './flow.ts';

test('the radios page lists every radio from the catalogue, with its checks and its backup gaps', async ({
  page,
}) => {
  await page.goto('radios/');
  const rows = page.getByTestId('radio-table').locator('tbody tr');
  await expect(rows).toHaveCount(13);
  const c62 = rows.filter({ hasText: 'Retevis C62' });
  await expect(c62).toContainText('Yes, 2026-11-21');
  await expect(c62).toContainText('Everything');
  const cs7000 = rows.filter({ hasText: /CS7000-M17\s*$|CS7000-M17(?! Plus)/ }).first();
  await expect(cs7000).toContainText('critical gap');
  // A radio's name leads to the flasher with that radio chosen.
  await rows.filter({ hasText: 'Module 17' }).getByRole('link', { name: 'Module 17' }).click();
  await expect(page).toHaveURL(/\/#mod17$/);
  await expect(step(page, 'step-radio')).toContainText('Module 17');
});

test('the backups page says, from the record the flasher reads, what each backup leaves out', async ({
  page,
}) => {
  await page.goto('backups/');
  await expect(page.getByRole('heading', { name: 'What a backup keeps', level: 1 })).toBeVisible();
  await expect(page.getByTestId('backups-whole')).toContainText('Retevis C62');
  await expect(page.getByTestId('backups-whole')).toContainText('Module 17');
  // The worst first, one section for each radio with a gap.
  const sections = page.locator('section[data-testid^="backups-"]');
  await expect(sections).toHaveCount(11);
  await expect(sections.first()).toHaveAttribute('data-testid', 'backups-cs7000');
  await expect(page.getByTestId('backups-cs7000')).toContainText('factory calibration');
  // A radio's backup gaps in the radios table lead to its section here.
  await page.goto('radios/');
  await page
    .getByTestId('radio-table')
    .locator('tbody tr')
    .filter({ hasText: 'MD-9600' })
    .getByRole('link', { name: /critical gap/ })
    .click();
  await expect(page).toHaveURL(/\/backups\/#md9600$/);
});

test('every page says whose it is, under which licences, and which commit it was built from', async ({
  page,
}) => {
  for (const address of ['', 'radios/', 'backups/', 'credits/']) {
    await page.goto(address);
    const licence = page.getByTestId('site-licence');
    await expect(licence, address).toContainText('© OpenRTX contributors');
    await expect(licence, address).toContainText('Flasher: GPL-3.0-or-later');
    // The website's text is the website's to licence, not this repository's.
    await expect(licence, address).not.toContainText('CC BY-SA');
    // The commit, linked to where GitHub shows it.
    const build = page.getByTestId('site-build');
    await expect(build, address).toHaveCount(1);
    await expect(build, address).toHaveText(/^Build [0-9a-f]{7}\.$/);
    const commit = (await build.textContent())!.replace(/^Build |\.$/g, '');
    await expect(build.getByRole('link')).toHaveAttribute(
      'href',
      `https://github.com/turnrye/openrtx-web-flasher/commit/${commit}`,
    );
  }
  await page.getByTestId('site-licence').getByRole('link', { name: 'licences and credits' }).click();
  await expect(page).toHaveURL(/\/credits\/$/);
});

test('the backup step says before the read what the backup will not hold', async ({ page }) => {
  await page.goto('?sim=1#mduv3x0');
  await pickBuild(page);
  await answerRuns(page, 'original');
  const gaps = page.getByTestId('backup-gaps');
  await expect(gaps).toContainText('will not hold everything in the Tytera MD-UV380');
  await expect(gaps.locator('li')).toHaveCount(2);
  await expect(gaps).toContainText('program memory');
  await expect(gaps).toContainText('needs a dumper');
  await expect(page.getByTestId('backup-gaps-more')).toHaveAttribute('href', /\/backups\/#mduv3x0$/);

  // A radio whose backup holds everything has no such note.
  await page.goto('?sim=1#mod17');
  await page.reload();
  await pickBuild(page);
  await expect(step(page, 'step-enter')).toHaveAttribute('data-mode', 'open');
  await page.getByTestId('entered').click();
  await expect(step(page, 'step-backup')).toHaveAttribute('data-mode', 'open');
  await expect(page.getByTestId('backup')).toBeVisible();
  await expect(page.getByTestId('backup-gaps')).toHaveCount(0);
});

test('every page leads back to openrtx.org and between the flasher’s pages', async ({ page }) => {
  await page.goto('radios/');
  await expect(page.getByTestId('home-link')).toHaveAttribute('href', 'https://openrtx.org/');
  const nav = page.getByTestId('site-nav');
  await expect(nav.getByRole('link', { name: 'Radios' })).toHaveAttribute('aria-current', 'page');
  await nav.getByRole('link', { name: 'Backups' }).click();
  await expect(page).toHaveURL(/\/backups\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('What a backup keeps');
  await nav.getByRole('link', { name: 'Flash' }).click();
  await expect(page.getByTestId('radio-md3x0')).toBeVisible();
});
