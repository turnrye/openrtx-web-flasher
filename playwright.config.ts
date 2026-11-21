// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig, devices } from '@playwright/test';

// By default the tests run against the built site (dist/), served the way a Pages host
// serves it: as plain files under a sub-path, to catch absolute URLs.
// Set E2E_BASE_URL (with a trailing slash) to run them against a published copy instead,
// for example a pull request preview.
const PORT = 4173;
const remote = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: remote ?? `http://localhost:${PORT}/sub/path/`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: remote
    ? undefined
    : {
        command: `node tests/e2e/serve.mjs ${PORT}`,
        url: `http://localhost:${PORT}/sub/path/`,
        reuseExistingServer: !process.env.CI,
      },
});
