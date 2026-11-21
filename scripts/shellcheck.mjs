#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Runs the shellcheck pinned in vendor.json on the files given. The binary is downloaded
 * once into the per-user cache (scripts/cache.mjs), checked against its checksum and
 * reused from then on, so linting does not depend on a download.
 *
 *   node scripts/shellcheck.mjs ci/*.sh
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cacheDir, download } from './cache.mjs';

const pin = JSON.parse(readFileSync(new URL('../vendor.json', import.meta.url), 'utf8')).tools.shellcheck;
const platform = `${process.platform}-${process.arch}`;
const build = pin.builds[platform];
if (!build) {
  console.error(`No pinned shellcheck for ${platform}; add one to vendor.json.`);
  process.exit(2);
}

const dir = join(cacheDir(), 'tools', `shellcheck-${pin.version}-${platform}`);
const binary = join(dir, 'shellcheck');
if (!existsSync(binary)) {
  const archive = await download(build.url);
  const actual = createHash('sha256').update(archive).digest('hex');
  if (actual !== build.sha256) {
    console.error(`shellcheck ${pin.version}: checksum ${actual} does not match vendor.json`);
    process.exit(2);
  }
  const work = `${dir}.part`;
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, 'shellcheck.tar.xz'), archive);
  // The archive holds one folder, shellcheck-<version>/, with the binary inside.
  execFileSync('tar', ['-xJf', 'shellcheck.tar.xz', '--strip-components', '1'], { cwd: work });
  chmodSync(join(work, 'shellcheck'), 0o755);
  rmSync(join(work, 'shellcheck.tar.xz'));
  rmSync(dir, { recursive: true, force: true });
  renameSync(work, dir);
  console.log(`shellcheck ${pin.version}: downloaded`);
}

process.exit(spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' }).status ?? 1);
