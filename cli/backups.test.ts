// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { makeBundle } from '../src/backup/bundle.ts';
import type { RadioBackup } from '../src/backup/types.ts';
import { checkWritable, knownBackups, saveBackup } from './backups.ts';
import { folder, removeFolders } from './test-support.ts';

/** A backup bundle of `model` for the radio with ID `radioId`, taken at `when`. */
async function bundle(model: string, radioId: string | null, when: string, complete = true) {
  const backup: RadioBackup = {
    radioId,
    idKind: radioId ? 'chip-id' : null,
    notes: [],
    parts: [{ file: 'flash.bin', kind: 'internal-flash', address: 0, data: new Uint8Array(64), complete }],
  };
  return makeBundle({ id: model, name: model }, backup, 'flashing-mode', new Date(when));
}

afterAll(removeFolders);

describe('backups in a folder', () => {
  it('knows which radios of a model are backed up there, and in which file', async () => {
    const dir = folder();
    const old = await bundle('c62', 'C620240900065701', '2026-11-01T10:00:00');
    const newer = await bundle('c62', 'C620240900065701', '2026-11-20T10:00:00');
    const other = await bundle('c62', 'C620240900069999', '2026-11-10T10:00:00');
    const mod17 = await bundle('mod17', 'SIM0001', '2026-11-10T10:00:00');
    const unnamed = await bundle('c62', null, '2026-11-11T10:00:00');
    for (const b of [old, newer, other, mod17, unnamed]) saveBackup(dir, b.name, b.zip);
    // A file with a backup's name that is no backup, and one that is not a zip at all.
    writeFileSync(join(dir, 'backup_c62_ffffffff_20261101-0000.zip'), 'not a zip');
    writeFileSync(join(dir, 'notes.txt'), 'hello');

    const known = knownBackups(dir, 'c62');
    expect([...known.keys()].sort()).toEqual(['C620240900065701', 'C620240900069999']);
    // The newest backup of a radio is the one named.
    expect(known.get('C620240900065701')).toBe(newer.name);
    expect(knownBackups(dir, 'mod17').get('SIM0001')).toBe(mod17.name);
    expect(knownBackups(dir, 'md9600').size).toBe(0);
    expect(knownBackups(join(dir, 'not-there'), 'c62').size).toBe(0);
  });

  it('does not count a backup that was not read to the end', async () => {
    const dir = folder();
    const partial = await bundle('rt4d', 'ABCD1234', '2026-11-20T10:00:00', false);
    saveBackup(dir, partial.name, partial.zip);
    expect(knownBackups(dir, 'rt4d').size).toBe(0);
    const whole = await bundle('rt4d', 'ABCD1234', '2026-11-21T10:00:00');
    saveBackup(dir, whole.name, whole.zip);
    expect(knownBackups(dir, 'rt4d').get('ABCD1234')).toBe(whole.name);
  });

  it('does not count a backup with a part that could not be read at all', async () => {
    const dir = folder();
    const backup: RadioBackup = {
      radioId: '0123456789ABCDEF00112233',
      idKind: 'uid',
      notes: [],
      parts: [
        { file: 'info-07.bin', kind: 'info', data: new Uint8Array(16), complete: true },
        {
          file: 'spi-flash.bin',
          kind: 'spi-flash',
          address: 0,
          data: new Uint8Array(0),
          complete: false,
          note: 'The read stopped after 0 of 16777216 bytes: refused.',
        },
      ],
    };
    const { name, zip } = await makeBundle(
      { id: 'mduv3x0', name: 'MD-UV380' },
      backup,
      'original-firmware',
      new Date('2026-11-20T10:00:00'),
    );
    saveBackup(dir, name, zip);
    expect(knownBackups(dir, 'mduv3x0').size).toBe(0);
  });

  it('says before any read when the folder cannot be written to', () => {
    const dir = folder();
    expect(() => checkWritable(join(dir, 'new', 'one'))).not.toThrow();
    // A file where the folder should be.
    writeFileSync(join(dir, 'taken'), 'x');
    expect(() => checkWritable(join(dir, 'taken', 'sub'))).toThrow(/cannot be saved in .*Nothing was read/);
  });

  it('saves into a new folder and never replaces a backup', async () => {
    const dir = join(folder(), 'new', 'folder');
    const { name, zip } = await bundle('c62', 'C620240900065701', '2026-11-01T10:00:00');
    const first = saveBackup(dir, name, zip);
    const second = saveBackup(dir, name, Uint8Array.of(1, 2, 3));
    expect(basename(first)).toBe(name);
    expect(basename(second)).toBe(name.replace('.zip', '-2.zip'));
    expect(Buffer.compare(readFileSync(first), zip)).toBe(0);
    expect(readdirSync(dir).length).toBe(2);
  });
});
