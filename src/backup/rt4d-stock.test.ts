// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  readRt4dStock,
  rt4dStockChecksum,
  RT4D_ALL_BYTES,
  RT4D_CALIBRATION_BYTES,
  RT4D_QUICK_BYTES,
  RT4D_SPI_BLOCK_SIZE,
  type Rt4dStockOptions,
} from './rt4d-stock.ts';
import type { BackupScope } from './types.ts';
import { FlashError, quietContext, type Progress } from '../flash/types.ts';
import { SimRt4dStock, type SimRt4dStockOptions } from '../sim/rt4d-stock.ts';

/** Short timeouts so the failure cases do not wait for a real radio. */
const fast: Rt4dStockOptions = { responseTimeoutMs: 40, quietMs: 2 };

/** A chip just large enough for the quick scope, to keep the tests light. */
const small: SimRt4dStockOptions = { flashSize: RT4D_QUICK_BYTES };

/** Reads a fresh simulator and returns what happened. */
function run(
  scope: BackupScope,
  simOptions: SimRt4dStockOptions = small,
  options: Rt4dStockOptions = fast,
  prepare?: (sim: SimRt4dStock) => void,
) {
  const sim = new SimRt4dStock(simOptions);
  prepare?.(sim);
  const seen: Progress[] = [];
  const log: string[] = [];
  const done = readRt4dStock(
    sim,
    scope,
    quietContext({ progress: (p) => seen.push(p), log: (m) => log.push(m) }),
    options,
  );
  return { sim, seen, log, done };
}

/** What the reader's fingerprint should be, worked out another way. */
function sha16(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/** True when the reader sent nothing but block reads. */
function onlyRead(sim: SimRt4dStock): boolean {
  return sim.forbidden.length === 0 && sim.errors.length === 0 && sim.notifies === 0 && sim.closes === 0;
}

describe('rt4dStockChecksum', () => {
  it('is the plain byte sum, modulo 256', () => {
    expect(rt4dStockChecksum(Uint8Array.of(0x52, 0, 0))).toBe(0x52);
    // The reference tool's "notify" and "close" packets end in 0x44 and 0x79.
    expect(rt4dStockChecksum(Uint8Array.of(0x34, 0x00, 0x00, 0x10))).toBe(0x44);
    expect(rt4dStockChecksum(Uint8Array.of(0x34, 0x52, 0x05, 0xee))).toBe(0x79);
    expect(rt4dStockChecksum(new Uint8Array(0))).toBe(0);
  });
});

describe('readRt4dStock', () => {
  it('reads the first megabyte for the quick scope', async () => {
    const { sim, seen, done } = run('quick', { flashSize: 2 * RT4D_QUICK_BYTES });
    const backup = await done;

    expect(backup.parts).toHaveLength(1);
    const [part] = backup.parts;
    expect(part.file).toBe('spi-flash.bin');
    expect(part.kind).toBe('spi-flash');
    expect(part.address).toBe(0);
    expect(part.complete).toBe(true);
    expect(part.note).toBeUndefined();
    expect(part.data.length).toBe(RT4D_QUICK_BYTES);
    expect(Buffer.compare(part.data, sim.flash.subarray(0, RT4D_QUICK_BYTES))).toBe(0);

    const blocks = RT4D_QUICK_BYTES / RT4D_SPI_BLOCK_SIZE;
    expect(sim.reads).toEqual(Array.from({ length: blocks }, (_, i) => i));
    expect(onlyRead(sim)).toBe(true);
    expect(seen[0]).toEqual({ phase: 'connect', done: 0, total: RT4D_QUICK_BYTES });
    expect(seen.at(-1)).toEqual({ phase: 'done', done: RT4D_QUICK_BYTES, total: RT4D_QUICK_BYTES });
    expect(seen.filter((p) => p.phase === 'read')).toHaveLength(blocks);
    expect(backup.notes.join(' ')).toMatch(/first megabyte/);
    expect(backup.firmware).toBeUndefined();
  });

  it('reads the first 4 MiB of a 16 MiB chip for the all scope', async () => {
    const { sim, seen, done } = run('all', {});
    const backup = await done;

    const [part] = backup.parts;
    expect(part.complete).toBe(true);
    expect(part.data.length).toBe(RT4D_ALL_BYTES);
    expect(Buffer.compare(part.data, sim.flash.subarray(0, RT4D_ALL_BYTES))).toBe(0);
    expect(sim.reads).toHaveLength(RT4D_ALL_BYTES / RT4D_SPI_BLOCK_SIZE);
    expect(Math.max(...sim.reads)).toBe(RT4D_ALL_BYTES / RT4D_SPI_BLOCK_SIZE - 1);
    expect(onlyRead(sim)).toBe(true);
    expect(seen.at(-1)).toEqual({ phase: 'done', done: RT4D_ALL_BYTES, total: RT4D_ALL_BYTES });
    expect(backup.notes.join(' ')).toMatch(/address book .* not included/);
  });

  it('opens the port at 115200 8N1 and closes it afterwards', async () => {
    const { sim, done } = run('quick');
    await done;
    expect(sim.opens).toEqual([
      { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' },
    ]);
    expect(sim.opened).toBe(false);
    expect(sim.signals).toEqual([]);
  });

  it('copes with replies that arrive in pieces and with noise on the line', async () => {
    const { sim, done } = run('quick', { ...small, chunkBytes: 100, noise: [0x00, 0xff, 0x52] });
    const backup = await done;
    expect(backup.parts[0].complete).toBe(true);
    expect(Buffer.compare(backup.parts[0].data, sim.flash)).toBe(0);
    expect(onlyRead(sim)).toBe(true);
  });

  it('says so when the radio is in flashing mode', async () => {
    for (const bootloaderReply of [[0xff], [0xff, 0xff, 0xff, 0xff]]) {
      const { sim, seen, done } = run('quick', { ...small, mode: 'bootloader', bootloaderReply });
      const error = await done.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FlashError);
      expect((error as FlashError).message).toMatch(/flashing mode/);
      expect((error as FlashError).message).toMatch(/switch it on normally, without holding any key/);
      expect(sim.forbidden).toEqual([]);
      expect(sim.opened).toBe(false);
      expect(seen.some((p) => p.phase === 'read')).toBe(false);
    }
  });

  it('says to check the cable when nothing answers', async () => {
    const { sim, done } = run('quick', { ...small, mode: 'silent' });
    const error = await done.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FlashError);
    expect((error as FlashError).message).toMatch(/did not answer/);
    expect((error as FlashError).message).toMatch(/cable/);
    expect((error as FlashError).message).toMatch(/switched on/);
    expect(sim.forbidden).toEqual([]);
    expect(sim.opened).toBe(false);
  });

  it('rejects answers that are not the original firmware’s', async () => {
    const { sim, done } = run('quick', { ...small, wrongHeader: { block: 0, times: Infinity } });
    const error = await done.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FlashError);
    expect((error as FlashError).message).toMatch(/answer starts with 52 00 01, not 52 00 00/);
    expect(sim.forbidden).toEqual([]);
    expect(sim.opened).toBe(false);
  });

  it('asks again for a block whose checksum is wrong', async () => {
    const { sim, log, done } = run('quick', { ...small, corruptChecksum: { block: 7 } });
    const backup = await done;
    expect(backup.parts[0].complete).toBe(true);
    expect(Buffer.compare(backup.parts[0].data, sim.flash)).toBe(0);
    expect(sim.reads.filter((b) => b === 7)).toHaveLength(2);
    expect(sim.reads).toHaveLength(RT4D_QUICK_BYTES / RT4D_SPI_BLOCK_SIZE + 1);
    expect(log.some((line) => /Block 7 .*checksum/.test(line))).toBe(true);
    expect(onlyRead(sim)).toBe(true);
  });

  it('asks again for a block whose header is for another block', async () => {
    const { sim, done } = run('quick', { ...small, wrongHeader: { block: 300 } });
    const backup = await done;
    expect(backup.parts[0].complete).toBe(true);
    expect(Buffer.compare(backup.parts[0].data, sim.flash)).toBe(0);
    expect(sim.reads.filter((b) => b === 300)).toHaveLength(2);
    expect(onlyRead(sim)).toBe(true);
  });

  it('asks again for a block that got no answer', async () => {
    const { sim, done } = run('quick', { ...small, drop: { block: 3, times: 2 } });
    const backup = await done;
    expect(backup.parts[0].complete).toBe(true);
    expect(Buffer.compare(backup.parts[0].data, sim.flash)).toBe(0);
    expect(sim.reads.filter((b) => b === 3)).toHaveLength(3);
    expect(onlyRead(sim)).toBe(true);
  });

  it('keeps what was read when a block never comes', async () => {
    const { sim, seen, done } = run('quick', { ...small, drop: { block: 20 } });
    const backup = await done;
    const [part] = backup.parts;
    const kept = 20 * RT4D_SPI_BLOCK_SIZE;

    expect(part.complete).toBe(false);
    expect(part.data.length).toBe(kept);
    expect(Buffer.compare(part.data, sim.flash.subarray(0, kept))).toBe(0);
    expect(part.note).toMatch(/stopped at 0x005000/);
    expect(part.note).toMatch(/no answer/);
    expect(backup.notes.join(' ')).toMatch(/Read it again/);
    expect(sim.reads.filter((b) => b === 20)).toHaveLength(3);
    expect(Math.max(...sim.reads)).toBe(20);
    expect(seen.at(-1)).toEqual({ phase: 'done', done: kept, total: RT4D_QUICK_BYTES });
    // The calibration area was read, so the radio still has its ID.
    expect(backup.radioId).toBe(sha16(sim.flash.subarray(0, RT4D_CALIBRATION_BYTES)));
    expect(onlyRead(sim)).toBe(true);
    expect(sim.opened).toBe(false);
  });

  it('keeps what was read when a block stays corrupted', async () => {
    const { sim, done } = run(
      'quick',
      { ...small, corruptChecksum: { block: 2, times: Infinity } },
      { ...fast, attempts: 2 },
    );
    const backup = await done;
    const [part] = backup.parts;
    expect(part.complete).toBe(false);
    expect(part.data.length).toBe(2 * RT4D_SPI_BLOCK_SIZE);
    expect(Buffer.compare(part.data, sim.flash.subarray(0, 2 * RT4D_SPI_BLOCK_SIZE))).toBe(0);
    expect(part.note).toMatch(/checksum/);
    expect(sim.reads.filter((b) => b === 2)).toHaveLength(2);
    // Less than the calibration area was read: no ID.
    expect(backup.radioId).toBeNull();
    expect(backup.idKind).toBeNull();
    expect(onlyRead(sim)).toBe(true);
    expect(sim.opened).toBe(false);
  });

  it('identifies the radio by a checksum of its calibration area', async () => {
    const first = run('quick');
    const backup = await first.done;
    expect(backup.idKind).toBe('fingerprint');
    expect(backup.radioId).toMatch(/^[0-9a-f]{16}$/);
    expect(backup.radioId).toBe(sha16(first.sim.flash.subarray(0, RT4D_CALIBRATION_BYTES)));

    // The same radio gives the same ID whatever else is on the chip and whatever the scope.
    const again = run('quick', small, fast, (sim) => sim.flash.fill(0x5a, RT4D_CALIBRATION_BYTES));
    expect((await again.done).radioId).toBe(backup.radioId);

    const other = run('quick', { ...small, seed: 2 });
    expect((await other.done).radioId).not.toBe(backup.radioId);
  });

  it('gives no ID for a blank calibration area', async () => {
    for (const fill of [0xff, 0x00]) {
      const { sim, done } = run('quick', small, fast, (s) => s.flash.fill(fill, 0, RT4D_CALIBRATION_BYTES));
      const backup = await done;
      expect(backup.radioId).toBeNull();
      expect(backup.idKind).toBeNull();
      expect(backup.parts[0].complete).toBe(true);
      expect(Buffer.compare(backup.parts[0].data, sim.flash)).toBe(0);
      expect(backup.notes.join(' ')).toMatch(/tells this radio from another/);
    }
  });

  it('reports a port that will not open', async () => {
    const sim = new SimRt4dStock(small);
    await sim.open({ baudRate: 9600 });
    await expect(readRt4dStock(sim, 'quick', quietContext(), fast)).rejects.toThrow(
      /Could not open the serial port/,
    );
    expect(sim.forbidden).toEqual([]);
  });
});

describe('SimRt4dStock', () => {
  /** Opens a simulator, writes `bytes` and returns it. */
  async function send(bytes: number[]): Promise<SimRt4dStock> {
    const sim = new SimRt4dStock(small);
    await sim.open({ baudRate: 115200 });
    const writer = sim.writable!.getWriter();
    await writer.write(Uint8Array.from(bytes));
    writer.releaseLock();
    return sim;
  }

  it('records commands that could write and does not act on them', async () => {
    const before = new SimRt4dStock(small).flash.slice();
    const cases: [bytes: number[], what: RegExp][] = [
      [[0x40, 0x00, 0x00, ...new Array<number>(1025).fill(0)], /region write 0x40/],
      [[0x90, 0x00, 0x00, ...new Array<number>(1025).fill(0)], /region write 0x90/],
      [[0xa5, 0x00, 0x00], /region write 0xa5/],
      [[0x39, 0x33, 0x05, 0x10, 0xc9], /bootloader erase/],
      [[0x57, 0x00, 0x00], /bootloader write/],
      [[0x12], /unknown command 0x12/],
    ];
    for (const [bytes, what] of cases) {
      const sim = await send(bytes);
      expect(sim.forbidden).toHaveLength(1);
      expect(sim.forbidden[0]).toMatch(what);
      expect(Buffer.compare(sim.flash, before)).toBe(0);
    }
  });

  it('answers the reference tool’s session commands', async () => {
    const sim = await send([0x34, 0x00, 0x00, 0x10, 0x44, 0x34, 0x52, 0x05, 0xee, 0x79]);
    expect(sim.notifies).toBe(1);
    expect(sim.closes).toBe(1);
    expect(sim.forbidden).toEqual([]);
    const reader = sim.readable!.getReader();
    expect((await reader.read()).value).toEqual(Uint8Array.of(0x06));
    reader.releaseLock();
  });
});

describe('a radio that is already backed up', () => {
  it('is recognised from its first 4 KiB, and the read stops there', async () => {
    const sim = new SimRt4dStock(small);
    const asked: string[] = [];
    const result = await readRt4dStock(sim, 'all', quietContext(), fast, (id) => {
      asked.push(id);
      return true;
    });
    const id = sha16(sim.flash.subarray(0, RT4D_CALIBRATION_BYTES));
    expect(result).toEqual({ known: id });
    expect(asked).toEqual([id]);
    expect(sim.reads).toEqual([0, 1, 2, 3]);
    expect(onlyRead(sim)).toBe(true);
  });

  it('is read in full when its ID is not one that is known', async () => {
    const sim = new SimRt4dStock(small);
    const result = await readRt4dStock(sim, 'quick', quietContext(), fast, () => false);
    expect('known' in result).toBe(false);
    expect(sim.reads).toHaveLength(RT4D_QUICK_BYTES / 1024);
  });
});
