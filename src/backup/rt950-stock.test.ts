// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  readRt950Stock,
  rt950StockKeyPacket,
  rt950StockXor,
  RT950_CALIBRATION_START,
  RT950_STOCK_BYTES,
  type Rt950StockOptions,
} from './rt950-stock.ts';
import { FlashError, quietContext, type Progress } from '../flash/types.ts';
import { SimRt950Stock, type SimRt950StockOptions } from '../sim/rt950-stock.ts';

/** Short timeouts so the failure cases do not wait for a real radio. */
const fast: Rt950StockOptions = { responseTimeoutMs: 40, quietMs: 2 };

/** A repeatable stand-in for Math.random. */
function seeded(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

/** Reads a fresh simulated radio and returns what happened. */
function run(simOptions: SimRt950StockOptions = {}, options: Rt950StockOptions = fast) {
  const sim = new SimRt950Stock(simOptions);
  const seen: Progress[] = [];
  const log: string[] = [];
  const done = readRt950Stock(sim, quietContext({ progress: (p) => seen.push(p), log: (m) => log.push(m) }), {
    random: seeded(7),
    ...options,
  });
  return { sim, seen, log, done };
}

describe('rt950StockXor', () => {
  const key = new TextEncoder().encode('CO 7');

  it('leaves a byte alone under a space, and where XOR would give or take 0x00 or 0xFF', () => {
    const plain = Uint8Array.of(0x12, 0x34, 0x56, 0x78, 0x00, 0xff, 0x41, 0x37, 0x43, 0xb0, 0x99, 0xc8);
    const out = rt950StockXor(plain, key);
    expect([...out]).toEqual([
      0x12 ^ 0x43,
      0x34 ^ 0x4f,
      0x56, // under the space
      0x78 ^ 0x37,
      0x00,
      0xff,
      0x41, // under the space
      0x37, // the key byte itself
      0x43, // the key byte itself
      0xb0, // the complement of the key byte 0x4F
      0x99, // under the space
      0xc8, // the complement of the key byte 0x37
    ]);
  });

  it('undoes itself for every byte value', () => {
    const all = Uint8Array.from({ length: 1024 }, (_, i) => i & 0xff);
    expect([...rt950StockXor(rt950StockXor(all, key), key)]).toEqual([...all]);
  });
});

describe('rt950StockKeyPacket', () => {
  it('is SEND, a selector, 19 table indices and a zero, and names the key the selector points at', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { packet, key } = rt950StockKeyPacket(seeded(seed));
      expect(packet).toHaveLength(25);
      expect(String.fromCharCode(...packet.subarray(0, 4))).toBe('SEND');
      expect([1, 2]).toContain(packet[4] >> 4);
      expect(packet[4] & 0x0f).toBeLessThanOrEqual(4);
      expect([...packet.subarray(5, 24)].every((b) => b <= 19)).toBe(true);
      expect(packet[24]).toBe(0);
      expect(key).toHaveLength(4);
    }
    // The reference's rule, by hand: selector 0x12 points at packet[4 + 5].
    const fixed = rt950StockKeyPacket(() => 0.5);
    expect(fixed.packet[4]).toBe(0x22);
    expect(String.fromCharCode(...fixed.key)).toBe(' SAT');
  });
});

describe('readRt950Stock against the simulated radio', () => {
  it('reads the 64 KiB the protocol reaches, calibration first, and ends the session', async () => {
    const { sim, seen, log, done } = run();
    const backup = await done;
    expect(sim.forbidden).toEqual([]);
    expect(sim.errors).toEqual([]);
    expect(backup.parts).toHaveLength(1);
    expect(backup.parts[0]).toMatchObject({
      file: 'spi-flash.bin',
      kind: 'spi-flash',
      address: 0,
      complete: true,
    });
    expect(Buffer.compare(backup.parts[0].data, sim.flash)).toBe(0);

    expect(sim.reads).toHaveLength(RT950_STOCK_BYTES / 128);
    expect(sim.reads[0]).toBe(RT950_CALIBRATION_START);
    expect(sim.reads[32]).toBe(0);
    expect(sim.sessions).toBe(1);
    expect(sim.ended).toBe(1);
    expect(sim.opens).toEqual([
      { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' },
    ]);
    expect(sim.opened).toBe(false);

    expect(backup.idKind).toBe('fingerprint');
    expect(backup.radioId).toMatch(/^[0-9a-f]{16}$/);
    expect(backup.notes.join(' ')).toContain('radtels.com/pages/software-download');
    expect(backup.notes.join(' ')).toContain('303132333435363738393a3b3c3d3e3f');
    // The identity stays out of the log, which may be sent in a report.
    expect(log.join('\n')).not.toContain('30313233');
    expect(seen[0]).toEqual({ phase: 'connect', done: 0, total: RT950_STOCK_BYTES });
    expect(seen.at(-1)).toEqual({ phase: 'done', done: RT950_STOCK_BYTES, total: RT950_STOCK_BYTES });
  });

  it('gives the same radio the same ID, and another radio another', async () => {
    const a = await run({ seed: 3 }).done;
    const again = await run({ seed: 3 }).done;
    const other = await run({ seed: 4 }).done;
    expect(again.radioId).toBe(a.radioId);
    expect(other.radioId).not.toBe(a.radioId);
  });

  it('copes with answers in pieces and with noise before the handshake', async () => {
    const { sim, done } = run({ chunkBytes: 5, noise: [0x41, 0x0d, 0x0a] });
    const backup = await done;
    expect(Buffer.compare(backup.parts[0].data, sim.flash)).toBe(0);
    expect(sim.forbidden).toEqual([]);
  });

  it('asks again for a block whose answer is lost or is for another address', async () => {
    for (const fault of [{ dropAt: 0x0400 }, { wrongAddressAt: 0x0400 }]) {
      const { sim, log, done } = run(fault);
      const backup = await done;
      expect(Buffer.compare(backup.parts[0].data, sim.flash)).toBe(0);
      expect(sim.reads.filter((at) => at === 0x0400)).toHaveLength(2);
      expect(log.join('\n')).toContain('Block at 0x0400');
    }
  });

  it('gives up on a block the radio never answers, and still ends the session', async () => {
    const { sim, done } = run({ deadAt: 0x0800 });
    await expect(done).rejects.toThrow(/stopped at 0x0800.*Nothing was saved/);
    expect(sim.reads.filter((at) => at === 0x0800)).toHaveLength(3);
    expect(sim.ended).toBe(1);
    expect(sim.opened).toBe(false);
  });

  it('stops after the calibration when the radio is already backed up', async () => {
    const first = await run().done;
    const sim = new SimRt950Stock();
    const asked: string[] = [];
    const result = await readRt950Stock(sim, quietContext(), { ...fast, random: seeded(9) }, (id) => {
      asked.push(id);
      return true;
    });
    expect(result).toEqual({ known: first.radioId });
    expect(asked).toEqual([first.radioId]);
    expect(sim.reads).toHaveLength((RT950_STOCK_BYTES - RT950_CALIBRATION_START) / 128);
    expect(sim.ended).toBe(1);
  });

  it('reads on when the radio is not a known one', async () => {
    const sim = new SimRt950Stock();
    const result = await readRt950Stock(sim, quietContext(), { ...fast, random: seeded(9) }, () => false);
    if ('known' in result) throw new Error('the read stopped although the radio is not known');
    expect(Buffer.compare(result.parts[0].data, sim.flash)).toBe(0);
  });

  it('says so when the radio does not answer, as in flashing mode', async () => {
    const { sim, done } = run({ mode: 'silent' });
    await expect(done).rejects.toThrow(FlashError);
    await expect(done).rejects.toThrow(/did not answer.*normal mode, not flashing mode/);
    expect(sim.opened).toBe(false);
  });

  it('refuses an answer that is not Radtel’s, and a radio of another model', async () => {
    const odd = run({ handshakeReply: 0xaa });
    await expect(odd.done).rejects.toThrow(/not the way Radtel's firmware does \(0xaa\)/);
    expect(odd.sim.reads).toEqual([]);

    const other = run({ model: 'RT-880' });
    await expect(other.done).rejects.toThrow(/says it is "RT-880", not an RT-950 Pro/);
    expect(other.sim.reads).toEqual([]);
    // The session was opened, so it is ended.
    expect(other.sim.ended).toBe(1);
  });

  it('has no ID to give when the calibration area is blank', async () => {
    const sim = new SimRt950Stock();
    sim.flash.fill(0xff, RT950_CALIBRATION_START);
    const backup = await readRt950Stock(sim, quietContext(), { ...fast, random: seeded(2) });
    expect(backup.radioId).toBeNull();
    expect(backup.idKind).toBeNull();
    expect(backup.notes.join(' ')).toContain('calibration area is empty');
  });
});
