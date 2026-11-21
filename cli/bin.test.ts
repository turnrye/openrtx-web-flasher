// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The program npx runs: the bundle cli/vite.config.ts makes, built here from the sources
 * as they are and run as its own process. It must not need anything that a git install
 * does not bring: only Node, the bundle and, for real devices, the optional packages.
 */
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openBundle } from '../src/backup/bundle.ts';
import { folder, removeFolders } from './test-support.ts';

const dir = folder();
const bundle = join(dir, 'openrtx-flasher.mjs');

/** Runs the bundle with `args` in an empty folder; resolves with its exit code and output. */
async function run(...args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [bundle, ...args], { cwd: dir });
    return { code: 0, out: stdout };
  } catch (e) {
    const failed = e as { code?: number; stdout?: string };
    return { code: failed.code ?? -1, out: failed.stdout ?? '' };
  }
}

afterAll(removeFolders);

describe('the bundled program', () => {
  beforeAll(async () => {
    await build({
      configFile: fileURLToPath(new URL('vite.config.ts', import.meta.url)),
      build: { outDir: dir, emptyOutDir: false },
    });
  }, 60_000);

  it('is one file that starts with a shebang and imports nothing but Node itself', () => {
    expect(readdirSync(dir)).toEqual(['openrtx-flasher.mjs']);
    const text = readFileSync(bundle, 'utf8');
    expect(text.startsWith('#!/usr/bin/env node\n')).toBe(true);
    const imported = [...text.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]);
    expect(imported.length).toBeGreaterThan(0);
    expect(imported.filter((name) => !name.startsWith('node:') && name !== 'module')).toEqual([]);
    // The packages that reach real devices are named at run time, not bundled or imported.
    expect(text).not.toMatch(/from "(usb|serialport|node-hid)"/);
  });

  it('answers --version, --help and a mistake with the right exit codes', async () => {
    const version = await run('--version');
    expect(version.code).toBe(0);
    expect(version.out).toMatch(/^openrtx-flasher, build \w+\n$/);
    expect((await run('--help')).out).toContain('openrtx-flasher flash <radio> <firmware>');
    expect((await run('radios', 'c62')).out).toContain('dsp_firmware.bin');
    expect((await run('nonsense')).code).toBe(2);
    expect((await run('flash', 'nothing', 'release')).code).toBe(1);
  });

  it('backs up and restores a simulated radio as its own process', async () => {
    const backup = await run('backup', 'mod17', '--sim', '--out', 'backups');
    expect(backup.code).toBe(0);
    expect(backup.out).toContain('Simulator: the backup holds exactly what the simulated radio held');
    const [name] = readdirSync(join(dir, 'backups'));
    const saved = await openBundle(readFileSync(join(dir, 'backups', name)));
    expect(saved.manifest.radio).toBe('mod17');
    // Node says who made the bundle, where the page gives the browser.
    expect(saved.manifest.tool.userAgent).toMatch(/^Node\.js/);

    const restore = await run('flash', 'mod17', join('backups', name), '--sim', '--yes');
    expect(restore.code).toBe(0);
    expect(restore.out).toContain('Simulator: the simulated radio holds exactly what was written.');
    // Without a terminal nobody can say yes, so nothing is written.
    expect((await run('flash', 'mod17', join('backups', name), '--sim')).code).toBe(1);
  }, 60_000);
});
