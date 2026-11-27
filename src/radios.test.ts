// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  backupFor,
  checksFor,
  filesFor,
  forCommandLine,
  pickFile,
  radioById,
  radioForFile,
  RADIOS,
} from './radios.ts';

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
    // docs/bench-notes.md: only the C62 has been read from the page on a real radio.
    expect(unchecked).toEqual(
      RADIOS.filter((r) => r.method !== 'uf2-copy' && r.id !== 'c62').map((r) => r.id),
    );
    // Each of those reads names what it leaves out, or leaves nothing out.
    const silent = RADIOS.filter((r) => {
      const backup = backupFor(r);
      return backup.how === 'read' && !backup.notIncluded;
    }).map((r) => r.id);
    expect(silent).toEqual(['mod17', 'c62']);
    const rt4d = backupFor(radioById('rt4d')!);
    expect(rt4d.how === 'read' && rt4d.time).toBe('about half an hour');
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
    // The page sends people to other tools for this radio, the maker's first.
    expect(page.useInstead!.tools.map((t) => t.url)).toEqual([
      page.manual.url,
      'https://github.com/imostlylurk/cs7000plus_flasher',
    ]);
    expect(RADIOS.filter((r) => r.useInstead).map((r) => r.id)).toEqual(['cs7000p']);
  });

  it('keeps warnings where they apply, not in a block before flashing', () => {
    expect(radioById('cs7000p')!.flashNotes).toHaveLength(3);
    expect(radioById('ttwrplus')!.flashNotes).toHaveLength(2);
    expect(RADIOS.filter((r) => r.flashNotes).map((r) => r.id)).toEqual(['cs7000p', 'rt950pro', 'ttwrplus']);
  });

  it('names the maker of every radio, as its name does', () => {
    for (const radio of RADIOS) {
      expect(radio.maker, radio.id).toBeTruthy();
      // Module 17 is named for the protocol, not its maker.
      if (radio.id !== 'mod17') {
        expect(radio.name.toLowerCase().startsWith(radio.maker.toLowerCase()), radio.id).toBe(true);
      }
    }
    expect(radioById('mod17')!.maker).toBe('M17 Project');
  });

  it('marks as checked only the radios with a line in the bench record', () => {
    // docs/verification.md has the evidence for each of these.
    expect(RADIOS.filter((r) => r.verified).map((r) => r.id)).toEqual(['mduv3x0', 'dm1701', 'cs7000', 'c62']);
    // The command line's checks are a record of their own, by what was done.
    const withCommandLine = (purpose: 'flash' | 'backup') =>
      RADIOS.filter((r) => checksFor(r).commandLine[purpose]).map((r) => r.id);
    expect(withCommandLine('flash')).toEqual(['mduv3x0', 'md9600', 'cs7000p']);
    expect(withCommandLine('backup')).toEqual([]);
  });

  it('gives the page’s check and the command line’s side by side, and neither for the other', () => {
    for (const radio of RADIOS) {
      const checks = checksFor(radio);
      expect(checks.page, radio.id).toBe(radio.verified);
      expect(checks.commandLine, radio.id).toEqual(radio.commandLineVerified ?? {});
      // The command line flashes the radio as `forCommandLine` gives it; the record stays with it.
      expect(checksFor(forCommandLine(radio)), radio.id).toEqual(checks);
    }
    expect(checksFor(radioById('md9600')!)).toMatchObject({ page: null, commandLine: { flash: {} } });
    expect(checksFor(radioById('c62')!)).toMatchObject({ page: { date: '2026-11-21' }, commandLine: {} });
  });

  it('names the two states of a radio the same way for every radio', () => {
    for (const radio of RADIOS.filter((r) => r.method !== 'uf2-copy' && r.method !== 'stm32-dfu')) {
      expect(radio.enter.join(' '), radio.id).toMatch(/the radio is in flashing mode/);
    }
  });
});
