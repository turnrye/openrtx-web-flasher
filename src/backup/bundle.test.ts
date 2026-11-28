// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  BUNDLE_FORMAT,
  bundleFileName,
  bundleSize,
  isBundle,
  makeBundle,
  openBundle,
  restorablePart,
} from './bundle.ts';
import type { RadioBackup } from './types.ts';

const RADIO = { id: 'md9600', name: 'Tytera MD-9600' };
const WHEN = new Date(2026, 10, 21, 6, 5);

/** A backup like the one read from a TYT radio's original firmware. */
function stockBackup(): RadioBackup {
  return {
    radioId: '0123456789ABCDEF00112233',
    idKind: 'uid',
    firmware: 'S126.061',
    notes: ['The radio restarted after the read.'],
    parts: [
      { file: 'info-07.bin', kind: 'info', data: new Uint8Array(randomBytes(16)), complete: true },
      {
        file: 'bootloader-4096.bin',
        kind: 'internal-flash',
        address: 0x08000000,
        data: new Uint8Array(randomBytes(4096)),
        complete: false,
        note: 'This computer allowed only 4096 bytes.',
      },
      {
        file: 'spi-flash.bin',
        kind: 'spi-flash',
        address: 0,
        data: new Uint8Array(randomBytes(70000)),
        complete: true,
      },
    ],
  };
}

describe('backup bundles', () => {
  it('round-trips parts, manifest and checksums', async () => {
    const backup = stockBackup();
    const { name, zip, manifest } = await makeBundle(RADIO, backup, 'original-firmware', WHEN);
    expect(name).toBe('backup_md9600_00112233_20261121-0605.zip');
    expect(bundleFileName(manifest)).toBe(name);
    expect(manifest.format).toBe(BUNDLE_FORMAT);
    expect(manifest.firmware).toBe('S126.061');
    expect(bundleSize(manifest)).toBe(16 + 4096 + 70000);
    expect(isBundle(zip)).toBe(true);

    const opened = await openBundle(zip);
    expect(opened.manifest).toEqual(manifest);
    expect(opened.parts.map((p) => p.file)).toEqual(['info-07.bin', 'bootloader-4096.bin', 'spi-flash.bin']);
    for (const [i, part] of opened.parts.entries()) {
      expect(Buffer.compare(part.data, backup.parts[i].data)).toBe(0);
      expect(part.complete).toBe(backup.parts[i].complete);
    }
    expect(opened.parts[1].note).toMatch(/4096/);
    // The manifest is plain JSON a person can read.
    expect(JSON.parse(strFromU8(unzipSync(zip)['backup.json']))).toMatchObject({
      radio: 'md9600',
      source: 'original-firmware',
    });
  });

  it('keeps a part that could not be read: empty, marked incomplete, with its note', async () => {
    const backup = stockBackup();
    backup.parts.push({
      file: 'calibration.bin',
      kind: 'info',
      address: 0x7c00,
      data: new Uint8Array(0),
      complete: false,
      note: 'The radio refused the request.',
    });
    const { zip, manifest } = await makeBundle(RADIO, backup, 'original-firmware', WHEN);
    expect(manifest.parts.at(-1)).toMatchObject({ file: 'calibration.bin', size: 0, complete: false });
    const opened = await openBundle(zip);
    const part = opened.parts.at(-1)!;
    expect(part.file).toBe('calibration.bin');
    expect(part.data).toHaveLength(0);
    expect(part.complete).toBe(false);
    expect(part.note).toBe('The radio refused the request.');
    expect(opened.manifest.parts.every((p) => p.complete)).toBe(false);
  });

  it('names a backup without an ID by radio and date only', async () => {
    const { name } = await makeBundle(
      RADIO,
      { ...stockBackup(), radioId: null, idKind: null },
      'original-firmware',
      WHEN,
    );
    expect(name).toBe('backup_md9600_20261121-0605.zip');
  });

  it('offers only a complete flashing-mode image for writing back', async () => {
    const image = new Uint8Array(randomBytes(8192));
    const flashing: RadioBackup = {
      radioId: 'C620240900065701',
      idKind: 'chip-id',
      notes: [],
      parts: [{ file: 'flash.bin', kind: 'internal-flash', address: 0, data: image, complete: true }],
    };
    const good = await openBundle(
      (await makeBundle({ id: 'c62', name: 'C62' }, flashing, 'flashing-mode', WHEN)).zip,
    );
    expect(restorablePart(good)?.file).toBe('flash.bin');

    const partial = { ...flashing, parts: [{ ...flashing.parts[0], complete: false }] };
    const cut = await openBundle(
      (await makeBundle({ id: 'c62', name: 'C62' }, partial, 'flashing-mode', WHEN)).zip,
    );
    expect(restorablePart(cut)).toBeNull();

    const stock = await openBundle((await makeBundle(RADIO, stockBackup(), 'original-firmware', WHEN)).zip);
    expect(restorablePart(stock)).toBeNull();
  });

  it('refuses damaged, foreign and newer files with a reason', async () => {
    const { zip } = await makeBundle(RADIO, stockBackup(), 'original-firmware', WHEN);
    const files = unzipSync(zip);

    await expect(openBundle(new Uint8Array([1, 2, 3]))).rejects.toThrow(/not a backup/);
    await expect(openBundle(zipSync({ 'openrtx_md3x0_x.bin': new Uint8Array(4) }))).rejects.toThrow(
      /no backup\.json/,
    );
    expect(isBundle(zipSync({ 'openrtx_md3x0_x.bin': new Uint8Array(4) }))).toBe(false);

    const flipped = { ...files, 'spi-flash.bin': files['spi-flash.bin'].slice() };
    flipped['spi-flash.bin'][100] ^= 1;
    await expect(openBundle(zipSync(flipped))).rejects.toThrow(/spi-flash\.bin does not match its checksum/);

    const { 'info-07.bin': _dropped, ...missing } = files;
    await expect(openBundle(zipSync(missing))).rejects.toThrow(/info-07\.bin is missing/);

    const newer = {
      ...files,
      'backup.json': strToU8(strFromU8(files['backup.json']).replace(BUNDLE_FORMAT, 'openrtx-backup/9')),
    };
    await expect(openBundle(zipSync(newer))).rejects.toThrow(/format this page does not know/);
  });

  it('opens a bundle that was unpacked and zipped again inside a folder', async () => {
    const { zip, manifest } = await makeBundle(RADIO, stockBackup(), 'original-firmware', WHEN);
    const inFolder = Object.fromEntries(
      Object.entries(unzipSync(zip)).map(([name, data]) => [`backup_md9600/${name}`, data]),
    );
    expect((await openBundle(zipSync(inFolder))).manifest).toEqual(manifest);
    // And it is recognised as a backup, not taken for a firmware zip.
    expect(isBundle(zipSync(inFolder))).toBe(true);
    expect(isBundle(zip)).toBe(true);
    expect(
      isBundle(zipSync({ 'notes/mybackup.json': new Uint8Array(2), 'zephyr.bin': new Uint8Array(2) })),
    ).toBe(false);
  });

  it('refuses two parts with the same file name', async () => {
    const backup = stockBackup();
    backup.parts[1].file = backup.parts[0].file;
    await expect(makeBundle(RADIO, backup, 'original-firmware', WHEN)).rejects.toThrow(/both called/);
  });
});
