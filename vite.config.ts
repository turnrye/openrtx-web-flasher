// SPDX-License-Identifier: GPL-3.0-or-later
import { execSync } from 'node:child_process';
import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

/** Where reports go unless FEEDBACK_URL says otherwise: this project's issues. */
const DEFAULT_FEEDBACK_URL = 'https://github.com/turnrye/openrtx-web-flasher/issues/new';

/** The commit being built: BUILD_ID when CI gives it, otherwise the checked-out one. */
function buildId(): string {
  if (process.env.BUILD_ID) return process.env.BUILD_ID.slice(0, 7);
  try {
    return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

/** The tracker's "new issue" address; an empty FEEDBACK_URL counts as not set. */
function feedbackUrl(): string {
  const set = process.env.FEEDBACK_URL;
  return set === undefined || set === '' ? DEFAULT_FEEDBACK_URL : set;
}

// base './' keeps every URL relative, so the same build runs at a domain root, under
// /<repo>/ on a Pages host, or under /pr-preview/pr-N/.
export default defineConfig({
  base: './',
  plugins: [preact()],
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
    __FEEDBACK_URL__: JSON.stringify(feedbackUrl()),
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rolldownOptions: { input: ['index.html', 'licences.html'] },
  },
  test: { include: ['src/**/*.test.ts', 'cli/**/*.test.ts'], environment: 'node' },
});
