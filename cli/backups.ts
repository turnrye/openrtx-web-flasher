// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Backups on disk. The page keeps a second copy of each backup in the browser and so
 * knows which radios it has backed up; the command line's record is the folder the
 * backups are saved in.
 */
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import type { BundleManifest } from '../src/backup/bundle.ts';
import { messageOf } from '../src/flash/types.ts';

/**
 * The backups of radio model `model` in `dir`: the ID of each radio that has one, and
 * the newest file that holds it. Zips that are not backups are passed over, and so are
 * backups with a part that was not read to the end: like the page, only a complete
 * backup counts.
 */
export function knownBackups(dir: string, model: string): Map<string, string> {
  const known = new Map<string, string>();
  if (!existsSync(dir)) return known;
  // Names carry the time they were taken, so sorted is oldest first and the newest wins.
  for (const name of readdirSync(dir).sort()) {
    if (!name.startsWith(`backup_${model}_`) || !name.endsWith('.zip')) continue;
    try {
      const files = unzipSync(readFileSync(join(dir, name)), {
        filter: (file) => file.name.endsWith('backup.json'),
      });
      const manifest = JSON.parse(strFromU8(Object.values(files)[0])) as BundleManifest;
      const complete = manifest.parts.every((part) => part.complete);
      if (manifest.radio === model && manifest.radioId && complete) known.set(manifest.radioId, name);
    } catch {
      // Not a backup this tool can read: it does not count.
    }
  }
  return known;
}

/**
 * Makes sure backups can be saved in `dir`, creating it if need be. Throws with a
 * message for the person when they cannot: better before a ten-minute read than after.
 */
export function checkWritable(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
  } catch (e) {
    throw new Error(
      `Backups cannot be saved in ${dir}: ${messageOf(e)}. Nothing was read. Name another folder with --out.`,
      { cause: e },
    );
  }
}

/** Saves a backup in `dir` under `name` without replacing a file; returns where it went. */
export function saveBackup(dir: string, name: string, zip: Uint8Array): string {
  mkdirSync(dir, { recursive: true });
  for (let n = 1; ; n++) {
    const path = join(dir, n === 1 ? name : name.replace(/\.zip$/, `-${n}.zip`));
    try {
      writeFileSync(path, zip, { flag: 'wx' });
      return path;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}
