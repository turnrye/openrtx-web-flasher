// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The site around the flasher: the pages written from the flasher's own data, the old
 * site's addresses, and what the backup step says a backup will not hold. The tests'
 * base address is the flasher's page, so the rest of the site is one level up.
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
  await expect(page).toHaveURL(/\/flash\/#mod17$/);
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
  await expect(page).toHaveURL(/\/flash\/backups\/#md9600$/);
});

test('every page of the old website is in the sidebar', async ({ page }) => {
  await page.goto('../user_guide/');
  const sidebar = page.locator('#starlight__sidebar');
  // The old site's sidebar, its orphans, and the developers' guide's pages.
  for (const slug of [
    'about',
    'get_in_touch',
    'posts',
    'dev_status',
    'user_guide',
    'developers_guide',
    'hardware/hardware',
    'accessibility',
    'm17/m17',
    'binary_cps_format',
    'docrepository',
    'hackathon',
    'compiling',
    'tests',
    'linux',
    'software',
    'nvm',
    'software_modes',
    'coding_style',
    'peripheral_table',
    'rtxlink',
    'website',
    'at1846_registers',
  ]) {
    await expect(sidebar.locator(`a[href$="/${slug}/"]`), slug).toHaveCount(1);
  }
  await expect(sidebar.locator('a[href="https://github.com/OpenRTX/OpenRTX-external-docs"]')).toHaveCount(1);
});

test('the old website’s files that are not pages are served where they were', async ({ request }) => {
  // Matrix finds openrtx.org's server here; the emulator and the icon have their own addresses.
  const matrix = await request.get('../.well-known/matrix/server');
  expect(matrix.status()).toBe(200);
  expect(await matrix.json()).toHaveProperty(['m.server']);
  for (const path of ['../emulator/', '../emulator/openrtx_linux.wasm', '../favicon.ico']) {
    expect((await request.get(path)).status(), path).toBe(200);
  }
});

test('an address of the old docsify site lands on the new page, at the heading it named', async ({
  page,
}) => {
  await page.goto('../#/user_guide?id=flashing-openrtx-to-your-radio');
  await expect(page).toHaveURL(/\/user_guide\/#flashing-openrtx-to-your-radio$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Users guide');

  await page.goto('../#/hardware/ttwrplus');
  await expect(page).toHaveURL(/\/hardware\/ttwrplus\/$/);
  // The old folder name had capitals; addresses here do not.
  await page.goto('../#/M17/m17?id=hardware-modifications');
  await expect(page).toHaveURL(/\/m17\/m17\/#hardware-modifications$/);
  // The old site's own redirects, to the M17 folder, still lead there.
  await page.goto('../#/md380_mods');
  await expect(page).toHaveURL(/\/m17\/md380_mods\/$/);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
});

test('a copied page is edited where it is kept, and a page written here in this repository', async ({
  page,
}) => {
  await page.goto('../user_guide/');
  await expect(page.getByRole('link', { name: 'Edit page' })).toHaveAttribute(
    'href',
    'https://github.com/OpenRTX/openrtx.github.io/edit/master/user_guide.md',
  );
  await page.goto('../contribute/');
  await expect(page.getByRole('link', { name: 'Edit page' })).toHaveAttribute(
    'href',
    /openrtx-web-flasher\/edit\/main\/site\/content\/docs\/contribute\.mdx$/,
  );
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
  await expect(page.getByTestId('backup-gaps-more')).toHaveAttribute('href', /\/flash\/backups\/#mduv3x0$/);

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
