// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { backupFor, filesFor, forCommandLine, pickFile, radioById, radioForFile, RADIOS } from './radios.ts';

const RELEASE = [
  'openrtx_cs7000p_v0.4.5.bin',
  'openrtx_cs7000p_v0.4.5.dfu',
  'openrtx_cs7000_v0.4.5.bin',
  'openrtx_cs7000_v0.4.5.dfu',
  'openrtx_dm1701_v0.4.5.bin',
  'openrtx_dm1801_v0.4.5.sgl',
  'openrtx_gd77_v0.4.5.sgl',
  'openrtx_linux_v0.4.5',
  'openrtx_md3x0_v0.4.5.bin',
  'openrtx_mduv3x0_v0.4.5.bin',
  'openrtx_mod17_v0.4.5.bin',
];

describe('radio catalogue', () => {
  it('has unique ids and complete entries', () => {
    expect(new Set(RADIOS.map((r) => r.id)).size).toBe(RADIOS.length);
    for (const radio of RADIOS) {
      expect(radio.enter.length).toBeGreaterThan(0);
      expect(radio.manual.url).toMatch(/^https:/);
    }
  });

  it('picks the right release file for each radio', () => {
    const pick = (id: string) => pickFile(radioById(id)!, RELEASE);
    expect(pick('md3x0')).toBe('openrtx_md3x0_v0.4.5.bin');
    expect(pick('mduv3x0')).toBe('openrtx_mduv3x0_v0.4.5.bin');
    expect(pick('cs7000')).toBe('openrtx_cs7000_v0.4.5.dfu');
    expect(pick('cs7000p')).toBe('openrtx_cs7000p_v0.4.5.dfu');
    expect(pick('gd77')).toBe('openrtx_gd77_v0.4.5.sgl');
    expect(pick('mod17')).toBe('openrtx_mod17_v0.4.5.bin');
    expect(pick('md9600')).toBeUndefined();
    expect(filesFor(radioById('cs7000p')!, RELEASE)).toEqual([
      'openrtx_cs7000p_v0.4.5.dfu',
      'openrtx_cs7000p_v0.4.5.bin',
    ]);
  });

  it('recognises CI and Zephyr file names', () => {
    expect(radioForFile('openrtx_md9600_fix-cal.bin')?.id).toBe('md9600');
    expect(radioForFile('openrtx_ttwrplus.uf2')?.id).toBe('ttwrplus');
    expect(radioForFile('build/zephyr/zephyr.bin')?.id).toBe('c62');
    expect(radioForFile('openrtx_linux_v0.4.5')).toBeUndefined();
    expect(radioForFile('notes.txt')).toBeUndefined();
  });

  it('knows which radios can be backed up, and how', () => {
    const how = Object.fromEntries(
      RADIOS.map((r) => {
        const backup = backupFor(r);
        return [
          r.id,
          backup.how === 'read' ? `${backup.mode}${backup.restorable ? ', restorable' : ''}` : backup.how,
        ];
      }),
    );
    expect(how).toEqual({
      md3x0: 'normal',
      mduv3x0: 'normal',
      md9600: 'normal',
      dm1701: 'normal',
      gd77: 'normal',
      dm1801: 'normal',
      cs7000: 'flashing, restorable',
      cs7000p: 'flashing, restorable',
      rt4d: 'normal',
      rt950pro: 'normal',
      mod17: 'flashing, restorable',
      ttwrplus: 'copy',
      c62: 'flashing, restorable',
    });
  });

  it('reads everything in one go, and says which reads are unmeasured', () => {
    for (const radio of RADIOS) {
      const backup = backupFor(radio);
      if (backup.how !== 'read') continue;
      expect(backup.time, radio.id).not.toBe('');
    }
    const unchecked = RADIOS.filter((r) => {
      const backup = backupFor(r);
      return backup.how === 'read' && backup.unchecked;
    }).map((r) => r.id);
    // Of the TYT radios only the MD-9600 read was measured; the RT-950 Pro's never was.
    expect(unchecked).toEqual(['md3x0', 'mduv3x0', 'dm1701', 'rt950pro']);
    const c62 = backupFor(radioById('c62')!);
    expect(c62.how === 'read' && c62.endsFlashingMode).toBe(true);
  });

  it('gives the command line its own way into a radio where a browser has none', () => {
    const page = radioById('cs7000p')!;
    const cli = forCommandLine(page);
    expect(page.method).toBe('stm32-dfu');
    expect(cli.method).toBe('cs7000-robot');
    expect(cli.commandLine).toBeUndefined();
    expect(cli.enter).not.toEqual(page.enter);
    expect(cli.ext).toBe('dfu');
    expect(backupFor(cli).how).toBe('none');
    expect(forCommandLine(radioById('mod17')!)).toBe(radioById('mod17'));
    expect(RADIOS.filter((r) => r.commandLine).map((r) => r.id)).toEqual(['cs7000p']);
  });

  it('keeps warnings where they apply, not in a block before flashing', () => {
    expect(radioById('cs7000p')!.flashNotes).toHaveLength(3);
    expect(radioById('ttwrplus')!.flashNotes).toHaveLength(2);
    expect(RADIOS.filter((r) => r.flashNotes).map((r) => r.id)).toEqual(['cs7000p', 'rt950pro', 'ttwrplus']);
  });

  it('marks as checked only the radios with a line in the bench record', () => {
    // docs/verification.md has the evidence for each of these.
    expect(RADIOS.filter((r) => r.verified).map((r) => r.id)).toEqual(['cs7000', 'c62']);
  });

  it('names the two states of a radio the same way for every radio', () => {
    for (const radio of RADIOS.filter((r) => r.method !== 'uf2-copy' && r.method !== 'stm32-dfu')) {
      expect(radio.enter.join(' '), radio.id).toMatch(/the radio is in flashing mode/);
    }
  });
});
