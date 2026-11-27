// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  gd77CodeplugRanges,
  GD77_CALIBRATION_ADDRESS,
  GD77_CALIBRATION_DATA_BYTES,
  GD77_CALIBRATION_WINDOW_BYTES,
  readGd77Stock,
  type Gd77StockOptions,
} from './gd77-stock.ts';
import { encodeGd77Frame, gd77Framing, type Gd77Model } from '../flash/gd77.ts';
import { FlashError, quietContext, type Progress } from '../flash/types.ts';
import { SimGd77 } from '../sim/gd77.ts';
import { SimGd77Stock, type SimGd77StockOptions } from '../sim/gd77-stock.ts';

/** The one note of a read that went well: what the radio does not give in normal mode. */
const ONLY_THE_CODEPLUG = [expect.stringMatching(/whole 1 MB memory chip .* special start-up mode/)];

/** A short timeout so the failure cases do not wait for a real radio. */
const fast: Gd77StockOptions = { responseTimeoutMs: 40 };

const MODELS: Gd77Model[] = ['GD-77', 'DM-1801'];

/** Reads a fresh simulator and returns what happened. */
function run(
  simOptions: SimGd77StockOptions,
  options: Gd77StockOptions = fast,
  prepare?: (sim: SimGd77Stock) => void,
) {
  const sim = new SimGd77Stock(simOptions);
  prepare?.(sim);
  const seen: Progress[] = [];
  const log: string[] = [];
  const done = readGd77Stock(
    sim,
    simOptions.model,
    quietContext({ progress: (p) => seen.push(p), log: (m) => log.push(m) }),
    options,
  );
  return { sim, seen, log, done };
}

/** What the reader's fingerprint should be, worked out another way. */
function sha16(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/** True when the radio saw nothing but a correct read-only conversation. */
function onlyRead(sim: SimGd77Stock): boolean {
  return sim.forbidden.length === 0 && sim.errors.length === 0;
}

/** True when a read request touches the window dmrconfig skips. */
function inSkippedRange(read: { address: number; length: number }): boolean {
  return read.address < 0x8000 && read.address + read.length > 0x7c00;
}

/** Bytes in the codeplug ranges of `model`. */
function codeplugBytes(model: Gd77Model): number {
  return gd77CodeplugRanges(model).reduce((sum, r) => sum + r.end - r.start, 0);
}

describe('gd77CodeplugRanges', () => {
  it('covers what dmrconfig reads, in whole 32-byte requests', () => {
    // dmrconfig: blocks 1..965 (GD-77) or 1..988 (DM-1801) of 128 bytes, without 248..255.
    const dmrconfigEnd: Record<Gd77Model, number> = { 'GD-77': 966 * 128, 'DM-1801': 989 * 128 };
    for (const model of MODELS) {
      const ranges = gd77CodeplugRanges(model);
      expect(ranges[0]).toEqual({ start: 0x80, end: 0x7c00, kind: 'eeprom' });
      expect(ranges[1]).toEqual({ start: 0x8000, end: 0x10000, kind: 'eeprom' });
      expect(ranges[2].start).toBe(0x10000);
      expect(ranges[2].kind).toBe('spi-flash');
      expect(ranges[2].end).toBeGreaterThanOrEqual(dmrconfigEnd[model]);
      expect(ranges[2].end).toBeLessThanOrEqual(0x20000);
      for (const r of ranges) expect((r.end - r.start) % 32).toBe(0);
    }
    expect(gd77CodeplugRanges('DM-1801')[2].end).toBe(989 * 128);
  });
});

describe.each(MODELS)('readGd77Stock on a %s', (model) => {
  it('reads every codeplug range and the calibration', async () => {
    const { sim, seen, done } = run({ model });
    const backup = await done;
    const ranges = gd77CodeplugRanges(model);

    expect(backup.parts.map((p) => p.file)).toEqual([
      'codeplug-00080.bin',
      'codeplug-08000.bin',
      'codeplug-10000.bin',
      'calibration.bin',
    ]);
    ranges.forEach((range, i) => {
      const part = backup.parts[i];
      expect(part.kind).toBe(range.kind);
      expect(part.address).toBe(range.start);
      expect(part.complete).toBe(true);
      expect(part.note).toMatch(/programming software/);
      expect(part.data.length).toBe(range.end - range.start);
      expect(Buffer.compare(part.data, sim.memory(range.start, range.end))).toBe(0);
    });

    const calibration = backup.parts[3];
    expect(calibration.kind).toBe('info');
    expect(calibration.address).toBe(GD77_CALIBRATION_ADDRESS);
    expect(calibration.complete).toBe(true);
    expect(calibration.data.length).toBe(GD77_CALIBRATION_WINDOW_BYTES);
    const window = sim.memory(0x7c00, 0x7c00 + GD77_CALIBRATION_WINDOW_BYTES);
    expect(Buffer.compare(calibration.data, window)).toBe(0);
    expect(Buffer.compare(calibration.data.subarray(0, 0x400), sim.calibration)).toBe(0);

    expect(backup.idKind).toBe('fingerprint');
    expect(backup.radioId).toBe(sha16(sim.calibration.subarray(0, GD77_CALIBRATION_DATA_BYTES)));
    expect(backup.firmware).toBe(model === 'GD-77' ? 'MD-760P V311' : '1801 V210');
    expect(backup.notes).toEqual(ONLY_THE_CODEPLUG);

    expect(sim.steps).toEqual(['PROGRA', 'M', 'ACK', 'CWB0', 'CWB1', 'CWB0']);
    expect(sim.ended).toBe(1);
    expect(onlyRead(sim)).toBe(true);

    const total = codeplugBytes(model) + GD77_CALIBRATION_WINDOW_BYTES;
    expect(seen[0]).toEqual({ phase: 'connect', done: 0, total });
    expect(seen.at(-1)).toEqual({ phase: 'done', done: total, total });
    expect(seen.at(-2)).toEqual({ phase: 'read', done: total, total });
    // The reader opened the device, so it closes it again.
    expect(sim.opened).toBe(false);
  });

  it('asks for the codeplug in 32-byte requests and never for the skipped range', async () => {
    const { sim, done } = run({ model }, { ...fast, calibration: false });
    const backup = await done;

    expect(backup.parts.map((p) => p.file)).toEqual([
      'codeplug-00080.bin',
      'codeplug-08000.bin',
      'codeplug-10000.bin',
    ]);
    expect(sim.reads.some(inSkippedRange)).toBe(false);
    expect(sim.reads.every((r) => r.length === 32)).toBe(true);
    expect(sim.reads).toHaveLength(codeplugBytes(model) / 32);
    expect(sim.reads[0].address).toBe(0x80);
    expect(Math.max(...sim.reads.map((r) => r.address + r.length))).toBe(gd77CodeplugRanges(model)[2].end);
    expect(sim.steps).toEqual(['PROGRA', 'M', 'ACK', 'CWB0', 'CWB1']);
    expect(backup.radioId).toBeNull();
    expect(backup.idKind).toBeNull();
    expect(sim.ended).toBe(1);
    expect(onlyRead(sim)).toBe(true);
  });

  it('tries the calibration window only after the whole codeplug is read', async () => {
    const { sim, done } = run({ model });
    await done;
    const first = sim.reads.findIndex(inSkippedRange);
    expect(first).toBe(codeplugBytes(model) / 32);
    // A 32-byte look first, then the window.
    expect(sim.reads[first]).toEqual({ address: 0x7c00, length: 32 });
    expect(sim.reads.slice(first + 1).map((r) => r.address)).toEqual(
      Array.from({ length: GD77_CALIBRATION_WINDOW_BYTES / 32 }, (_, i) => 0x7c00 + i * 32),
    );
  });

  it('lists the calibration as not read when the window reads as zeros', async () => {
    const { sim, seen, done } = run({ model, window: 'zeros' });
    const backup = await done;
    expect(backup.parts).toHaveLength(4);
    const calibration = backup.parts[3];
    expect(calibration.file).toBe('calibration.bin');
    expect(calibration.kind).toBe('info');
    expect(calibration.address).toBe(GD77_CALIBRATION_ADDRESS);
    expect(calibration.complete).toBe(false);
    expect(calibration.data).toHaveLength(0);
    expect(calibration.note).toMatch(/returned only empty bytes/);
    expect(backup.radioId).toBeNull();
    expect(backup.idKind).toBeNull();
    expect(backup.notes.join(' ')).toMatch(/calibration could not be read this way/);
    for (const [i, range] of gd77CodeplugRanges(model).entries()) {
      expect(Buffer.compare(backup.parts[i].data, sim.memory(range.start, range.end))).toBe(0);
    }
    expect(seen.at(-1)?.done).toBe(seen.at(-1)?.total);
    expect(sim.ended).toBe(1);
    expect(onlyRead(sim)).toBe(true);
  });

  it('lists the calibration as not read when the window reads as 0xFF', async () => {
    const { sim, done } = run({ model }, fast, (s) => s.calibration.fill(0xff));
    const backup = await done;
    expect(backup.parts).toHaveLength(4);
    expect(backup.parts[3]).toMatchObject({ file: 'calibration.bin', complete: false });
    expect(backup.parts[3].data).toHaveLength(0);
    expect(backup.radioId).toBeNull();
    expect(backup.notes.join(' ')).toMatch(/calibration could not be read this way/);
    expect(onlyRead(sim)).toBe(true);
  });

  it.each(['error', 'silent'] as const)(
    'carries on when the radio refuses the window (%s)',
    async (window) => {
      const { sim, seen, done } = run({ model, window });
      const backup = await done;
      // The codeplug is whole; the calibration is listed as the part that was not read.
      expect(backup.parts).toHaveLength(4);
      expect(backup.parts.slice(0, 3).every((p) => p.complete)).toBe(true);
      const calibration = backup.parts[3];
      expect(calibration.file).toBe('calibration.bin');
      expect(calibration.address).toBe(GD77_CALIBRATION_ADDRESS);
      expect(calibration.complete).toBe(false);
      expect(calibration.data).toHaveLength(0);
      expect(calibration.note).toMatch(/the radio refused the request/);
      expect(backup.radioId).toBeNull();
      expect(backup.notes.join(' ')).toMatch(/calibration could not be read this way/);
      // One refused request is enough; the session is still ended properly.
      expect(sim.reads.filter(inSkippedRange)).toHaveLength(1);
      expect(sim.ended).toBe(1);
      expect(seen.at(-1)?.phase).toBe('done');
      expect(seen.at(-1)?.done).toBe(seen.at(-1)?.total);
      expect(onlyRead(sim)).toBe(true);
      expect(sim.opened).toBe(false);
    },
  );

  it('keeps a window without the calibration marker but takes no ID from it', async () => {
    const { sim, done } = run({ model }, fast, (s) => s.calibration.set([0x12, 0x34]));
    const backup = await done;
    const calibration = backup.parts.find((p) => p.file === 'calibration.bin');
    expect(calibration?.note).toMatch(/does not start with the bytes A0 0F/);
    expect(backup.radioId).toBeNull();
    expect(backup.notes.join(' ')).toMatch(/does not look like calibration data/);
    expect(onlyRead(sim)).toBe(true);
  });

  it.each(['reply', 'silent'] as const)('says so when the radio is in flashing mode (%s)', async (mode) => {
    const { sim, done } = run({ model, bootloader: mode });
    const error = await done.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FlashError);
    expect((error as FlashError).message).toMatch(
      /in normal mode.*switch it on without holding the side keys/,
    );
    // Only the first handshake frame went out.
    expect(sim.sent).toHaveLength(1);
    expect(sim.forbidden).toEqual([]);
    expect(sim.reads).toEqual([]);
    expect(sim.opened).toBe(false);
  });

  it('sends the real bootloader simulator one frame and then stops', async () => {
    const sim = new SimGd77({ model });
    const error = await readGd77Stock(sim, model, quietContext(), fast).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FlashError);
    expect((error as FlashError).message).toMatch(
      /in normal mode.*switch it on without holding the side keys/,
    );
    expect(sim.sent).toHaveLength(1);
    expect(sim.steps).toEqual([]);
    expect(sim.erased).toBe(false);
    expect(sim.payload.length).toBe(0);
    expect(sim.opened).toBe(false);
  });

  it('gives the same ID for the same radio and another for another', async () => {
    const first = await run({ model }).done;
    // The codeplug changed, the calibration did not.
    const again = await run({ model }, fast, (s) => {
      s.eeprom.fill(0x5a, 0x80, 0x7c00);
      s.eeprom.fill(0xa5, 0x8000);
      s.flash.fill(0x3c);
    }).done;
    const other = await run({ model, seed: 2 }).done;
    expect(first.radioId).toMatch(/^[0-9a-f]{16}$/);
    expect(again.radioId).toBe(first.radioId);
    expect(other.radioId).not.toBe(first.radioId);
  });

  it('works with unnumbered reports', async () => {
    const { sim, done } = run({ model, numberedReports: false });
    const backup = await done;
    expect(backup.parts).toHaveLength(4);
    for (const [i, range] of gd77CodeplugRanges(model).entries()) {
      expect(Buffer.compare(backup.parts[i].data, sim.memory(range.start, range.end))).toBe(0);
    }
    expect(sim.sent.every(([reportId]) => reportId === 0)).toBe(true);
    expect(onlyRead(sim)).toBe(true);
  });

  it('leaves a device open that was open before', async () => {
    const sim = new SimGd77Stock({ model });
    await sim.open();
    await readGd77Stock(sim, model, quietContext(), fast);
    expect(sim.opened).toBe(true);
    expect(onlyRead(sim)).toBe(true);
  });

  it('fails when a codeplug read gets no reply, and still ends the session', async () => {
    const { sim, done } = run({ model, dropReadAt: 0x10020 });
    const error = await done.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FlashError);
    expect((error as FlashError).message).toMatch(/Reading the radio failed at 0x10020: no reply/);
    expect(sim.ended).toBe(1);
    expect(onlyRead(sim)).toBe(true);
    expect(sim.opened).toBe(false);
  });

  it('notes a radio that does not confirm the end of the read', async () => {
    const { sim, done } = run({ model, dropEndr: true });
    const backup = await done;
    expect(backup.parts).toHaveLength(4);
    expect(backup.notes.join(' ')).toMatch(/did not confirm the end of the read/);
    expect(sim.ended).toBe(1);
    expect(onlyRead(sim)).toBe(true);
  });
});

describe('readGd77Stock', () => {
  it('notes a radio that identifies itself as another model', async () => {
    const sim = new SimGd77Stock({ model: 'DM-1801' });
    const log: string[] = [];
    const backup = await readGd77Stock(sim, 'GD-77', quietContext({ log: (m) => log.push(m) }), fast);
    expect(backup.firmware).toBe('1801 V210');
    expect(backup.notes.join(' ')).toMatch(/calls itself "1801"/);
    expect(log.some((line) => line.startsWith('Warning:'))).toBe(true);
    expect(backup.parts).toHaveLength(4);
    expect(onlyRead(sim)).toBe(true);
  });

  it('accepts the name older GD-77 firmware gives', async () => {
    const ident = [0x4d, 0x44, 0x2d, 0x37, 0x36, 0x30, 0xff, 0xff, 0x56, 0x32, 0x30, 0x30, 0, 0, 0, 0];
    const { done } = run({ model: 'GD-77', ident });
    const backup = await done;
    expect(backup.firmware).toBe('MD-760 V200');
    expect(backup.notes).toEqual(ONLY_THE_CODEPLUG);
  });

  it('rejects an identification of the wrong length', async () => {
    const { sim, done } = run({ model: 'GD-77', ident: [0x4d, 0x44] });
    await expect(done).rejects.toThrow(/in normal mode/);
    // Like the references, nothing more is sent after a handshake that failed.
    expect(sim.sent).toHaveLength(2);
    expect(sim.reads).toEqual([]);
    expect(onlyRead(sim)).toBe(true);
  });
});

describe('SimGd77Stock', () => {
  /** Opens a simulator and sends it the handshake, then `frames`. */
  async function send(frames: number[][], handshake = true): Promise<SimGd77Stock> {
    const sim = new SimGd77Stock({ model: 'GD-77' });
    await sim.open();
    const framing = gd77Framing(sim);
    const all = handshake
      ? [[0x02, 0x50, 0x52, 0x4f, 0x47, 0x52, 0x41], [0x4d, 0x02], [0x41], ...frames]
      : frames;
    for (const payload of all) {
      const { reportId, data } = encodeGd77Frame(framing, Uint8Array.from(payload));
      await sim.sendReport(reportId, data);
    }
    return sim;
  }

  it('records writes and unknown commands and does not act on them', async () => {
    const fresh = new SimGd77Stock({ model: 'GD-77' });
    const cases: [frame: number[], what: RegExp][] = [
      [[0x57, 0x00, 0x80, 0x20, ...new Array<number>(32).fill(0)], /write \(W\) of 32 bytes at 0x80/],
      [[0x45, 0x4e, 0x44, 0x57], /ENDW/],
      [[0x43, 0x57, 0x42, 0x04, 0x00, 0x03, 0x00, 0x00], /bank select/],
      [[0x44, 0x4f, 0x57, 0x4e, 0x4c, 0x4f, 0x41, 0x44], /unknown command/],
      [[0x46, 0x2d, 0x45, 0x52, 0x41, 0x53, 0x45, 0xff], /unknown command/],
    ];
    for (const [frame, what] of cases) {
      for (const handshake of [true, false]) {
        const sim = await send([frame], handshake);
        expect(sim.forbidden).toHaveLength(1);
        expect(sim.forbidden[0]).toMatch(what);
        expect(Buffer.compare(sim.eeprom, fresh.eeprom)).toBe(0);
        expect(Buffer.compare(sim.flash, fresh.flash)).toBe(0);
        expect(Buffer.compare(sim.calibration, fresh.calibration)).toBe(0);
      }
    }
  });

  it('checks the handshake step by step', async () => {
    const skipped = await send([[0x52, 0x00, 0x80, 0x20]], false);
    expect(skipped.errors[0]).toMatch(/handshake step 1/);
    expect(skipped.reads).toEqual([]);

    const sim = new SimGd77Stock({ model: 'GD-77' });
    await sim.open();
    const framing = gd77Framing(sim);
    for (const payload of [[0x02, 0x50, 0x52, 0x4f, 0x47, 0x52, 0x41], [0x41]]) {
      const { reportId, data } = encodeGd77Frame(framing, Uint8Array.from(payload));
      await sim.sendReport(reportId, data);
    }
    expect(sim.steps).toEqual(['PROGRA']);
    expect(sim.errors[0]).toMatch(/handshake step 2/);
  });
});
