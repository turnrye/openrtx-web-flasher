// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { radioById } from '../radios.ts';
import { zipSync } from 'fflate';
import { companionsFor, fileForRadio, filesFromZip, type Build } from './builds.ts';

/** A build holding files with these names. */
function build(names: string[], extra: Partial<Build> = {}): Build {
  return {
    id: 'ci:test',
    kind: 'ci',
    label: 'PR #1',
    files: names.map((name) => ({ name, size: 4, data: new Uint8Array(4) })),
    ...extra,
  };
}

describe('the images a radio needs from a build', () => {
  const c62 = radioById('c62')!;

  it('the C62 needs its DSP image at 0x100000 next to the application', () => {
    // What GitHub CI puts in openrtx-c62.zip.
    const zip = build(['zephyr.bin', 'dsp_firmware.bin']);
    expect(fileForRadio(c62, zip)?.name).toBe('zephyr.bin');
    const [dsp, ...rest] = companionsFor(c62, zip);
    expect(rest).toEqual([]);
    expect(dsp).toMatchObject({ file: 'dsp_firmware.bin', address: 0x100000, what: 'DSP image' });
    expect(dsp.found?.name).toBe('dsp_firmware.bin');
  });

  it('finds the plainly named files of a radio in its folder, as the firmware mirror keeps them', () => {
    const mirrored = build([
      'openrtx_mod17_master.bin',
      'rt950pro/zephyr.bin',
      'c62/zephyr.bin',
      'c62/dsp_firmware.bin',
    ]);
    expect(fileForRadio(c62, mirrored)?.name).toBe('c62/zephyr.bin');
    expect(companionsFor(c62, mirrored)[0].found?.name).toBe('c62/dsp_firmware.bin');
    // Another radio's zephyr.bin is not the C62's.
    expect(fileForRadio(c62, build(['rt950pro/zephyr.bin']))).toBeUndefined();
    // A folder that is not a radio's says nothing: a zip may keep its files in one.
    expect(fileForRadio(c62, build(['build/zephyr.bin']))?.name).toBe('build/zephyr.bin');
  });

  it('takes the last part of a zip entry as its name, whichever separator the zip used', () => {
    const zip = zipSync({
      'folder/zephyr.bin': new Uint8Array(4),
      '..\\..\\x.btf': new Uint8Array(4),
      'empty/': new Uint8Array(0),
    });
    expect(
      filesFromZip(zip)
        .map((f) => f.name)
        .sort(),
    ).toEqual(['x.btf', 'zephyr.bin']);
  });

  it('says which image a build lacks', () => {
    const alone = companionsFor(c62, build(['zephyr.bin']));
    expect(alone).toHaveLength(1);
    expect(alone[0].found).toBeUndefined();
  });

  it('a backup is the whole flash and needs nothing next to it', () => {
    const backup = build(['flash.bin'], {
      backup: {
        format: 'openrtx-backup/1',
        radio: 'c62',
        model: 'Retevis C62 / C2',
        radioId: null,
        idKind: null,
        taken: '2026-11-21T00:00:00Z',
        source: 'flashing-mode',
        notes: [],
        parts: [],
        tool: { name: 'openrtx-web-flasher', userAgent: '' },
      },
    });
    expect(companionsFor(c62, backup)).toEqual([]);
  });

  it('radios with one image need nothing else', () => {
    for (const id of ['mduv3x0', 'mod17', 'cs7000p', 'gd77', 'rt4d']) {
      expect(companionsFor(radioById(id)!, build([`openrtx_${id}_x.bin`])), id).toEqual([]);
    }
  });
});
