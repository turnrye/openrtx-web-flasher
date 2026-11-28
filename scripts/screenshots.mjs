#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Takes the screenshots in docs/ from the built site, using the simulated radios.
 *
 *   SITE_BASE=/sub/path/ npm run build && node scripts/screenshots.mjs [output dir]
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const out = process.argv[2] || 'docs/screenshots';
const port = 4199;
mkdirSync(out, { recursive: true });
// The same server the browser tests use: dist/ under the path it was built for.
const base = `/${(process.env.SITE_BASE || '/sub/path/').replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');
const server = spawn('node', ['tests/e2e/serve.mjs', String(port)], {
  stdio: 'ignore',
  env: { ...process.env, SITE_BASE: base },
});
await new Promise((resolve) => setTimeout(resolve, 600));

try {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1200, height: 860 },
    deviceScaleFactor: 2,
    // Steps fold and open at once, so a screenshot never catches one half way.
    reducedMotion: 'reduce',
  });
  const top = `http://localhost:${port}${base}`;
  /** Takes one picture, from the top of the page: the site's bar stays where the page is scrolled to. */
  const shot = async (name, fullPage = true) => {
    await page.evaluate('window.scrollTo(0, 0)');
    await page.screenshot({ path: `${out}/${name}.png`, fullPage });
  };
  const id = (name) => page.getByTestId(name);
  /** Picks the first build the chosen radio can take. */
  const pickBuild = () =>
    page.locator('#step-firmware [data-testid^="build-"]:not([disabled])').first().click();
  // Tell the flasher this is not somebody's first visit, so the introduction is folded.
  const fold = () => id('before-you-start').locator('summary').click();

  // The site's front page.
  await page.goto(top, { waitUntil: 'networkidle' });
  await shot('1-home', false);

  // Step 1: the radios, with the introduction a first-timer sees.
  await page.goto(`${top}flash/?sim=1`);
  await id('radio-md3x0').waitFor();
  await shot('2-radios');

  // Step 2: the three choices of firmware.
  await page.goto(`${top}flash/?sim=1#mduv3x0`);
  await id('builds').waitFor();
  await fold();
  await shot('3-firmware');

  // Step 3: the backup, with what it will not hold said first.
  await pickBuild();
  await id('runs-original').click();
  await id('backup').waitFor();
  await shot('4-backup');

  // Step 4: how to enter flashing mode.
  await page.goto(`${top}flash/?sim=1#mod17`);
  await pickBuild();
  await id('entered').waitFor();
  await shot('5-flashing-mode');

  // Step 5: backed up, then flashed.
  await id('entered').click();
  await id('backup').click();
  await id('backup-done').waitFor();
  await id('backup-continue').click();
  await id('turn-on-experimental').click();
  await id('flash').click();
  await id('done').waitFor();
  await shot('6-flashed');

  // The pages around it: one written from the flasher's own data, one of the docs.
  await page.goto(`${top}radios/`, { waitUntil: 'networkidle' });
  await shot('7-radio-table', false);
  await page.goto(`${top}user_guide/`, { waitUntil: 'networkidle' });
  await shot('8-docs', false);
  await browser.close();
  console.log(`wrote screenshots to ${out}/`);
} finally {
  server.kill();
}
