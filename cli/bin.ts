#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `openrtx-flasher`: the program npx runs. cli/vite.config.ts bundles it into
 * cli/dist/openrtx-flasher.mjs when the package is installed.
 */
import { cacheDir, download } from '../scripts/cache.mjs';
import { backupDevice } from '../src/flash/run.ts';
import { CSKBURN_PIN, pinnedCskburn, platformName } from './cskburn.ts';
import { terminalIo } from './io.ts';
import { main } from './main.ts';
import { installedModules } from './node-env.ts';

const io = terminalIo({ input: process.stdin, output: process.stdout });
const code = await main(process.argv.slice(2), {
  io,
  fetch: (url, init) => fetch(url, init),
  env: process.env,
  cache: cacheDir(),
  modules: installedModules,
  cskburn: () =>
    pinnedCskburn(CSKBURN_PIN, platformName(), cacheDir(), (url) => {
      io.say(`Downloading cskburn ${CSKBURN_PIN.version} from LISTENAI (once)`);
      return download(url);
    }),
  readBackup: backupDevice,
  now: () => new Date(),
});
// Leave once the output is out: a USB or serial handle still open must not keep the process alive.
process.stdout.write('', () => process.exit(code));
