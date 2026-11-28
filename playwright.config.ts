// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig, devices } from '@playwright/test';

// By default the tests run against the built site (dist/), served the way a Pages host
// serves it: as plain files under the path it was built for. That is SITE_BASE, the
// variable the build reads; without it the tests expect a build made for /sub/path/, a
// sub-path so that absolute URLs which ignore the base fail.
// Set E2E_BASE_URL to the top of a published copy (for example a pull request preview)
// to run them against that instead.
/** An environment variable's value; an empty one, as an unset CI variable arrives, counts as not set. */
const given = (name: string): string | undefined =>
  process.env[name] === '' ? undefined : process.env[name];
const PORT = Number(given('E2E_PORT') ?? 4173);
/** SITE_BASE with one slash at each end, as astro.config.ts makes it. */
const PREFIX = `/${(given('SITE_BASE') ?? '/sub/path/').replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');
const remote = given('E2E_BASE_URL')?.replace(/\/*$/, '/');
const top = remote ?? `http://localhost:${PORT}${PREFIX}`;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    // The flasher is one page of the site, and the tests name addresses from it: '' is
    // the flasher, '../' the site's home page.
    baseURL: `${top}flash/`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: remote
    ? undefined
    : {
        command: `node tests/e2e/serve.mjs ${PORT} ${PREFIX}`,
        url: `${top}flash/`,
        reuseExistingServer: !process.env.CI,
      },
});
