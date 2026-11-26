#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `openrtx-flasher`: the program npx runs. cli/vite.config.ts bundles it into
 * cli/dist/openrtx-flasher.mjs when the package is installed.
 */
import { spawn } from 'node:child_process';
import { cacheDir, download } from '../scripts/cache.mjs';
import { backupDevice } from '../src/flash/run.ts';
import { CSKBURN_PIN, pinnedCskburn, platformName } from './cskburn.ts';
import { terminalIo } from './io.ts';
import { main } from './main.ts';
import { installedModules } from './node-env.ts';
import { RULES_PATH } from './udev.ts';

/** A word as a shell reads it back. */
function quoted(word: string): string {
  return /^[\w./=:@-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

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
  platform: process.platform,
  run: (command, args) =>
    new Promise((resolve) => {
      const child = spawn(command, args, { stdio: 'inherit' });
      child.on('error', () => resolve(127));
      child.on('close', (code) => resolve(code ?? 1));
    }),
  rulesPath: RULES_PATH,
  // npx's own name for the program is not on root's PATH, nor is an nvm Node: name both by path.
  asRoot: ['sudo', process.execPath, ...process.argv.slice(1)].map(quoted).join(' '),
});
// Leave once the output is out: a USB or serial handle still open must not keep the process alive.
process.stdout.write('', () => process.exit(code));
