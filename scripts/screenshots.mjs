#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Takes the screenshots in docs/ from the built site, using the simulated radios.
 *
 *   npm run build && node scripts/screenshots.mjs [output dir]
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const out = process.argv[2] || 'docs/screenshots';
const port = 4199;
mkdirSync(out, { recursive: true });
const server = spawn('node', ['tests/e2e/serve.mjs', String(port)], { stdio: 'ignore' });
await new Promise((resolve) => setTimeout(resolve, 600));

try {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1100, height: 900 },
    deviceScaleFactor: 2,
    // Steps fold and open at once, so a screenshot never catches one half way.
    reducedMotion: 'reduce',
  });
  const base = `http://localhost:${port}/sub/path/`;
  const shot = (name) => page.screenshot({ path: `${out}/${name}.png`, fullPage: true });

  // The radio list is drawn once the builds are known; show the second list unfolded.
  await page.goto(base);
  await page.locator('.radio-card').first().waitFor();
  await page.getByTestId('no-release').locator('summary').click();
  await shot('1-radios');

  // Step 2: the three choices, with "Other" open on a branch build.
  await page.goto(`${base}?sim=1#mduv3x0`);
  await page.getByTestId('open-other').click();
  await page.getByTestId('open-ci').click();
  await shot('2-firmware');

  // Step 3: the backup through the original firmware.
  await page.getByTestId('build-master').click();
  await page.locator('#step-backup').getByTestId('turn-on-experimental').click();
  await page.getByTestId('backup').click();
  await page.getByTestId('backup-done').waitFor();
  await shot('3-backed-up');

  // Step 4: how to enter flashing mode.
  await page.getByTestId('backup-continue').click();
  await shot('4-flashing-mode');

  // Step 5: flashed.
  await page.getByTestId('entered').click();
  await page.getByTestId('flash').click();
  await page.getByTestId('done').waitFor();
  await shot('5-flashed');
  await browser.close();
  console.log(`wrote screenshots to ${out}/`);
} finally {
  server.kill();
}
