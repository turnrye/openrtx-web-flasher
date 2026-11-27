// SPDX-License-Identifier: GPL-3.0-or-later
import * as prettier from 'prettier';
import { describe, expect, it } from 'vitest';
import { gd77CodeplugRanges } from './backup/gd77-stock.ts';
import { RT4D_ALL_BYTES } from './backup/rt4d-stock.ts';
import { RT950_STOCK_BYTES } from './backup/rt950-stock.ts';
import { TYT_STOCK_PLANS, type TytStockModel } from './backup/tyt-stock.ts';
import { coverageMarkdown } from './coverage-doc.ts';
import {
  COVERAGE,
  coverageFor,
  gapLine,
  gapsFor,
  isComplete,
  OPENRTX_LIMIT,
  openRtxLimit,
  sizeText,
  WORST_FIRST,
  type MemoryCoverage,
  type MemoryKind,
} from './coverage.ts';
import { backupFor, forCommandLine, radioById, RADIOS } from './radios.ts';

const DOC = '../docs/backup-coverage.md';
const MIB = 1024 * 1024;

/** The one memory of `kind` that radio `id` has. */
function memory(id: string, kind: MemoryKind): MemoryCoverage {
  const found = coverageFor({ id }).memories.filter((m) => m.kind === kind);
  expect(found, `${id} ${kind}`).toHaveLength(1);
  return found[0];
}

describe('backup coverage', () => {
  it('has an entry for every radio and for nothing else', () => {
    expect(Object.keys(COVERAGE)).toEqual(RADIOS.map((r) => r.id));
    for (const radio of RADIOS) {
      const { memories } = coverageFor(radio);
      expect(memories.length, radio.id).toBeGreaterThan(0);
      expect(
        memories.filter((m) => m.kind === 'internal-flash'),
        radio.id,
      ).toHaveLength(1);
    }
    expect(() => coverageFor({ id: 'nothing' })).toThrow(/No backup coverage/);
  });

  it('counts only the C62 and Module 17 as backed up whole', () => {
    expect(RADIOS.filter(isComplete).map((r) => r.id)).toEqual(['mod17', 'c62']);
    expect(gapsFor(radioById('c62')!)).toEqual([]);
    expect(gapsFor(radioById('mod17')!)).toEqual([]);
    // Every other radio is in the worst-first list, once.
    expect([...WORST_FIRST].sort()).toEqual(
      RADIOS.filter((r) => !isComplete(r))
        .map((r) => r.id)
        .sort(),
    );
    expect(WORST_FIRST.slice(0, 3)).toEqual(['cs7000', 'cs7000p', 'rt950pro']);
  });

  it('says of every gap what is lost and how it closes, and of nothing else', () => {
    for (const radio of RADIOS) {
      for (const m of coverageFor(radio).memories) {
        const where = `${radio.id} ${m.name}`;
        expect(m.holds, where).not.toBe('');
        expect(m.savedText, where).not.toBe('');
        if (m.saved === 'all') {
          expect(m.close.how, where).toBe('none-needed');
          expect(m.lost, where).toBeUndefined();
        } else {
          expect(m.close.how, where).not.toBe('none-needed');
          expect(m.lost, where).toMatch(/\w/);
        }
        // What is not read has no read to check.
        expect(m.check === undefined, where).toBe(m.saved === 'none');
        if (m.close.how === 'dumper') expect(m.close.does, where).toMatch(/\w/);
        if (m.close.how === 'other-tool') expect(m.close.url, where).toMatch(/^https:/);
      }
    }
  });

  it('agrees with what the page says a backup is', () => {
    for (const radio of RADIOS) {
      const backup = backupFor(radio);
      const coverage = coverageFor(radio);
      const internal = memory(radio.id, 'internal-flash');
      if (backup.how !== 'read') {
        // Nothing is read by the tool: no radio like that can count as saved whole.
        expect(isComplete(radio), radio.id).toBe(false);
        continue;
      }
      // Only a read in normal mode needs the manufacturer's firmware to answer.
      expect(coverage.needsOriginalFirmware, radio.id).toBe(backup.mode === 'normal');
      // A backup the page can write back is the program memory, read in flashing mode.
      expect(backup.restorable, radio.id).toBe(backup.mode === 'flashing');
      if (backup.restorable) expect(internal.saved, radio.id).not.toBe('none');
      // The page names what is missing before the read exactly when something is.
      expect(backup.notIncluded !== undefined, radio.id).toBe(!isComplete(radio));
      // "Unchecked" on the page and in the record are one fact.
      const checked = coverage.memories.some((m) => m.check === 'checked');
      expect(backup.unchecked === true, radio.id).toBe(!checked);
      // An unchecked read says why before it is made.
      if (backup.unchecked) expect(backup.caveat, radio.id).toMatch(/\w/);
    }
    // The T-TWR Plus is copied by hand, and its text says what the copy leaves out.
    const ttwr = backupFor(radioById('ttwrplus')!);
    expect(ttwr.how === 'copy' && ttwr.text).toMatch(/firmware only.*bootloader.*SA868S/);
    // In robot mode a CS7000 Plus gives nothing, and the text names the chip too.
    const robot = backupFor(forCommandLine(radioById('cs7000p')!));
    expect(robot.how === 'none' && robot.text).toMatch(/32 MB memory chip.*cannot be read/);
  });

  it('claims a read was run on a real radio only where the bench record has one', () => {
    const checked = RADIOS.filter((r) => coverageFor(r).memories.some((m) => m.check === 'checked'));
    // docs/bench-notes.md: the C62 backup was compared with a cskburn dump.
    expect(checked.map((r) => r.id)).toEqual(['c62']);
    for (const radio of checked) expect(radio.verified, radio.id).not.toBeNull();
    const elsewhere = RADIOS.filter((r) => coverageFor(r).memories.some((m) => m.check === 'other-tool'));
    expect(elsewhere.map((r) => r.id)).toEqual(['md9600']);
    expect(TYT_STOCK_PLANS.md9600.checked).toBe(true);
  });

  it('gives the sizes the readers read', () => {
    for (const { id } of RADIOS.filter((r) => r.method === 'tyt-dfu')) {
      const plan = TYT_STOCK_PLANS[id as TytStockModel];
      expect(plan, id).toBeDefined();
      expect(memory(id, 'spi-flash')).toMatchObject({ bytes: plan.spiSize, saved: 'all' });
      const internal = memory(id, 'internal-flash');
      expect(internal).toMatchObject({ bytes: MIB, saved: 'part' });
      expect(internal.savedText).toContain(plan.snapshot.toLocaleString('en-US'));
      expect(memory(id, 'other')).toMatchObject({ saved: 'none', close: { how: 'dumper' } });
    }
    for (const { id, hidModel } of RADIOS.filter((r) => r.method === 'gd77-hid')) {
      const ranges = gd77CodeplugRanges(hidModel!);
      const bytes = (kind: string) =>
        ranges
          .filter((r) => r.kind === kind)
          .reduce((sum, r) => sum + r.end - r.start, 0)
          .toLocaleString('en-US');
      expect(memory(id, 'eeprom').savedText).toContain(`${bytes('eeprom')} of`);
      expect(memory(id, 'spi-flash').savedText).toContain(`${bytes('spi-flash')} bytes`);
      expect(memory(id, 'internal-flash').saved).toBe('none');
    }
    expect(memory('rt4d', 'spi-flash')).toMatchObject({ bytes: RT4D_ALL_BYTES, saved: 'all' });
    expect(memory('rt4d', 'internal-flash').saved).toBe('none');
    const rt950 = memory('rt950pro', 'spi-flash');
    expect(rt950).toMatchObject({ bytes: 4 * MIB, saved: 'part' });
    expect(rt950.savedText).toContain(sizeText(RT950_STOCK_BYTES));
    // STM32 DFU reads the whole program memory, whose size goes by the chip.
    expect(memory('cs7000', 'internal-flash')).toMatchObject({ bytes: MIB, saved: 'all' });
    expect(memory('mod17', 'internal-flash')).toMatchObject({ bytes: MIB, saved: 'all' });
    expect(memory('cs7000p', 'internal-flash')).toMatchObject({ bytes: 2 * MIB, saved: 'part' });
    expect(memory('cs7000', 'spi-flash')).toMatchObject({ bytes: 16 * MIB, saved: 'none' });
    expect(memory('cs7000p', 'spi-flash')).toMatchObject({ bytes: 32 * MIB, saved: 'none' });
    // The memory chip the catalogue names, for the page to say what is left out, is this one.
    for (const radio of RADIOS.filter((r) => r.memoryChipMb !== undefined)) {
      expect(memory(radio.id, 'spi-flash').bytes, radio.id).toBe(radio.memoryChipMb! * MIB);
    }
    expect(memory('c62', 'internal-flash')).toMatchObject({ bytes: 4 * MIB, saved: 'all', check: 'checked' });
  });

  it('records which gaps need a dumper and which another tool closes', () => {
    const how = Object.fromEntries(
      RADIOS.map((r) => [r.id, [...new Set(gapsFor(r).map((gap) => gap.close.how))].join(', ')]),
    );
    expect(how).toEqual({
      md3x0: 'dumper',
      mduv3x0: 'dumper',
      md9600: 'dumper',
      dm1701: 'dumper',
      gd77: 'dumper',
      dm1801: 'dumper',
      cs7000: 'dumper',
      cs7000p: 'dumper',
      rt4d: 'dumper',
      rt950pro: 'dumper',
      mod17: '',
      ttwrplus: 'other-tool, dumper',
      c62: '',
    });
  });

  it('says that a radio already running OpenRTX cannot be read through the original firmware', () => {
    const limited = RADIOS.filter((r) => openRtxLimit(r) !== null).map((r) => r.id);
    expect(limited).toEqual(['md3x0', 'mduv3x0', 'md9600', 'dm1701', 'gd77', 'dm1801', 'rt4d', 'rt950pro']);
    expect(openRtxLimit(radioById('md9600')!)).toBe(OPENRTX_LIMIT);
    expect(openRtxLimit(radioById('c62')!)).toBeNull();
  });

  it('puts a gap in one line for the command line', () => {
    expect(gapsFor(radioById('cs7000')!).map(gapLine)).toEqual([
      'memory chip (W25Q128), 16 MiB: not saved; needs a dumper',
    ]);
    expect(gapsFor(radioById('ttwrplus')!).map(gapLine)).toEqual([
      'flash of the ESP32-S3, 16 MiB: saved in part; esptool reads it',
      'the radio module (SA868S), size not known: not saved; needs a dumper',
    ]);
    expect(sizeText(768)).toBe('768 bytes');
    expect(sizeText(64 * 1024)).toBe('64 KiB');
  });

  it('is what docs/backup-coverage.md says, word for word', async () => {
    const config = await prettier.resolveConfig(new URL(DOC, import.meta.url));
    const text = await prettier.format(coverageMarkdown(), { ...config, parser: 'markdown' });
    // After a change to the record: npm run coverage-doc
    await expect(text).toMatchFileSnapshot(DOC);
  });
});
