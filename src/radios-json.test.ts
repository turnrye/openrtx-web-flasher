// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Build } from './firmware/builds.ts';
import { RADIOS } from './radios.ts';
import { buildRadiosJson } from './radios-json.ts';

/** A release with one file, for the MD-UV380 only. */
const RELEASE: Build = {
  id: 'v0.4.5',
  kind: 'release',
  label: 'v0.4.5',
  date: '2026-10-04T08:23:00Z',
  url: 'https://github.com/OpenRTX/OpenRTX/releases/tag/v0.4.5',
  files: [
    { name: 'openrtx_mduv3x0_v0.4.5.bin', path: 'firmware/v0.4.5/openrtx_mduv3x0_v0.4.5.bin', size: 1 },
  ],
};

describe('buildRadiosJson', () => {
  it('gives every radio in catalogue order, in the agreed shape', () => {
    const doc = buildRadiosJson(RADIOS, RELEASE, 'https://openrtx.org/flash/', '2026-11-27T00:00:00.000Z');
    expect(doc.version).toBe(1);
    expect(doc.flasher).toBe('https://openrtx.org/flash/');
    expect(doc.release).toEqual({
      id: 'v0.4.5',
      date: '2026-10-04T08:23:00Z',
      url: 'https://github.com/OpenRTX/OpenRTX/releases/tag/v0.4.5',
    });
    expect(doc.radios.map((r) => r.id)).toEqual(RADIOS.map((r) => r.id));
    expect(doc.radios.find((r) => r.id === 'mduv3x0')).toEqual({
      id: 'mduv3x0',
      name: 'Tytera MD-UV380 / MD-UV390',
      aka: 'Retevis RT3S',
      maker: 'Tytera',
      alsoSoldBy: ['Retevis'],
      inRelease: true,
      m17: { need: 'mod', guide: 'https://openrtx.org/#/M17/mduv380_mods' },
      art: 'art/mduv3x0.svg',
      flash: '#mduv3x0',
    });
    // Fields a radio does not have are left out, not written empty.
    const mod17 = doc.radios.find((r) => r.id === 'mod17')!;
    expect(mod17).not.toHaveProperty('aka');
    expect(mod17).not.toHaveProperty('alsoSoldBy');
    expect(mod17.m17).toEqual({ need: 'built-in' });
    // Only the radios the release has a file for are in it.
    expect(doc.radios.filter((r) => r.inRelease).map((r) => r.id)).toEqual(['mduv3x0']);
  });

  it('counts every radio as in the release when the build mirrored none', () => {
    const doc = buildRadiosJson(RADIOS, undefined, '/sub/path/', '2026-11-27T00:00:00.000Z');
    expect(doc.release).toBeNull();
    expect(doc.flasher).toBe('/sub/path/');
    expect(doc.radios.every((r) => r.inRelease)).toBe(true);
  });
});
