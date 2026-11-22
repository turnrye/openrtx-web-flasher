// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  flashRt4d,
  rt4dChecksum,
  RT4D_BLOCK_SIZE,
  RT4D_LOAD_ADDRESS,
  RT4D_MEMORY_SIZE,
  type Rt4dOptions,
} from './rt4d.ts';
import { FlashError, quietContext, type Progress } from './types.ts';
import { SimRt4d, type SimRt4dOptions } from '../sim/rt4d.ts';

/** Short timeouts so the failure cases do not wait for a real radio. */
const fast: Rt4dOptions = { responseTimeoutMs: 40, quietMs: 2 };

/** A synthetic image: a plausible vector table, then pseudo-random bytes. */
function fakeImage(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed * 2654435761;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
  if (length >= 8) {
    const view = new DataView(out.buffer);
    view.setUint32(0, 0x20000200, true);
    view.setUint32(4, RT4D_LOAD_ADDRESS + 0x1c1, true);
  }
  return out;
}

/** The image as the bootloader should end up holding it: zero-padded to the region. */
function padded(bin: Uint8Array): Uint8Array {
  const out = new Uint8Array(RT4D_MEMORY_SIZE);
  out.set(bin);
  return out;
}

/** Flashes `bin` into a fresh simulator and returns what happened. */
function run(bin: Uint8Array, simOptions: SimRt4dOptions = {}, options: Rt4dOptions = fast) {
  const sim = new SimRt4d(simOptions);
  const seen: Progress[] = [];
  const log: string[] = [];
  const done = flashRt4d(
    sim,
    bin,
    quietContext({ progress: (p) => seen.push(p), log: (m) => log.push(m) }),
    options,
  );
  return { sim, seen, log, done };
}

describe('rt4dChecksum', () => {
  it('is the byte sum plus 72, modulo 256', () => {
    expect(rt4dChecksum(Uint8Array.of(0x52, 0, 0))).toBe(0x9a);
    expect(rt4dChecksum(Uint8Array.of(0x39, 0x33, 0x05, 0x10))).toBe(0xc9);
    expect(rt4dChecksum(Uint8Array.of(0x39, 0x33, 0x05, 0x55))).toBe(0x0e);
    expect(rt4dChecksum(new Uint8Array(0))).toBe(72);
  });
});

describe('flashRt4d against the simulated bootloader', () => {
  it('writes the zero-padded image and reports progress to the end', async () => {
    const bin = fakeImage(70_000);
    const { sim, seen, log, done } = run(bin);
    await done;
    expect(sim.errors).toEqual([]);
    expect(sim.complete).toBe(true);
    expect(Buffer.compare(sim.flash, padded(bin))).toBe(0);
    expect(sim.probes).toBe(1);
    expect(sim.erases).toBe(2);
    expect(sim.blocks).toBe(246);

    expect(sim.opens).toEqual([
      { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' },
    ]);
    expect(sim.opened).toBe(false);
    expect(sim.readable).toBeNull();

    expect(seen[seen.length - 1]).toEqual({ phase: 'done', done: RT4D_MEMORY_SIZE, total: RT4D_MEMORY_SIZE });
    const writes = seen.filter((p) => p.phase === 'write');
    expect(writes.length).toBe(247);
    expect(writes[writes.length - 1]).toEqual({
      phase: 'write',
      done: RT4D_MEMORY_SIZE,
      total: RT4D_MEMORY_SIZE,
    });
    expect(writes.every((p, i) => i === 0 || p.done === writes[i - 1].done + RT4D_BLOCK_SIZE)).toBe(true);
    expect(seen.filter((p) => p.phase === 'erase').length).toBe(3);
    expect(log.some((m) => m.includes('Warning'))).toBe(false);
  });

  it('sends the low 16 bits of the byte offset, wrapping every 64 KiB', async () => {
    const { sim, done } = run(fakeImage(1024));
    await done;
    expect(sim.offsets.length).toBe(246);
    expect(sim.offsets.slice(0, 3)).toEqual([0x0000, 0x0400, 0x0800]);
    expect(sim.offsets[63]).toBe(0xfc00);
    expect(sim.offsets[64]).toBe(0x0000);
    expect(sim.offsets[65]).toBe(0x0400);
    expect(sim.offsets[245]).toBe(0xd400);
  });

  it('accepts an image that fills the region exactly', async () => {
    const bin = fakeImage(RT4D_MEMORY_SIZE, 7);
    const { sim, done } = run(bin);
    await done;
    expect(Buffer.compare(sim.flash, bin)).toBe(0);
  });

  it('refuses an image larger than the region without opening the port', async () => {
    const { sim, done } = run(fakeImage(RT4D_MEMORY_SIZE + 1));
    await expect(done).rejects.toThrow(FlashError);
    await expect(done).rejects.toThrow(/too large/);
    expect(sim.opens.length).toBe(0);
  });

  it('refuses an empty image', async () => {
    const { sim, done } = run(new Uint8Array(0));
    await expect(done).rejects.toThrow(/empty/);
    expect(sim.opens.length).toBe(0);
  });

  it('warns about an image that is not linked for the RT-4D', async () => {
    const bin = fakeImage(4096);
    new DataView(bin.buffer).setUint32(4, 0x08000101, true);
    const { sim, log, done } = run(bin);
    await done;
    expect(log.some((m) => /Warning.*0x08000101/.test(m))).toBe(true);
    // Only a warning: the reference flashes whatever it is given.
    expect(sim.complete).toBe(true);
  });

  for (const probeReply of [[0xff], [0xff, 0x00, 0x00, 0x47]]) {
    it(`copes with a ${probeReply.length}-byte probe reply`, async () => {
      for (const splitReplies of [false, true]) {
        const bin = fakeImage(3000);
        const { sim, done } = run(bin, { probeReply, splitReplies });
        await done;
        expect(sim.errors).toEqual([]);
        expect(Buffer.compare(sim.flash, padded(bin))).toBe(0);
      }
    });
  }

  it('discards input that was waiting before the probe', async () => {
    const bin = fakeImage(3000);
    const { sim, done } = run(bin, { noise: [0x06, 0x00, 0xff, 0x41] });
    await done;
    expect(sim.errors).toEqual([]);
    expect(sim.complete).toBe(true);
  });

  it('fails when the radio is not in flashing mode', async () => {
    const { sim, done } = run(fakeImage(3000), { probeReply: [0x00] });
    await expect(done).rejects.toThrow(/not in flashing mode.*0x00/);
    expect(sim.erases).toBe(0);
    expect(sim.opened).toBe(false);
  });

  it('times out when nothing answers, and releases the port', async () => {
    const { sim, done } = run(fakeImage(3000), { silent: true });
    await expect(done).rejects.toThrow(/did not answer/);
    expect(sim.opened).toBe(false);
    // The same port object can be used again.
    await sim.open({ baudRate: 115200 });
    expect(sim.readable?.locked).toBe(false);
    expect(sim.writable?.locked).toBe(false);
    await sim.close();
  });

  it('fails when an erase command is refused', async () => {
    for (const nakErase of [0, 1]) {
      const { sim, done } = run(fakeImage(3000), { nakErase });
      await expect(done).rejects.toThrow(/Could not erase.*0x15/);
      expect(sim.blocks).toBe(0);
      expect(sim.opened).toBe(false);
    }
  });

  it('stops at a NAK and says where', async () => {
    const { sim, seen, done } = run(fakeImage(200_000), { nakBlock: 70 });
    await expect(done).rejects.toThrow(/Writing failed at 0x11800.*0x15/);
    expect(sim.blocks).toBe(70);
    expect(sim.complete).toBe(false);
    expect(seen.some((p) => p.phase === 'done')).toBe(false);
    const writes = seen.filter((p) => p.phase === 'write');
    expect(writes[writes.length - 1].done).toBe(70 * RT4D_BLOCK_SIZE);
    expect(sim.opened).toBe(false);
  });

  it('stops when a block is damaged on the way and the checksum no longer fits', async () => {
    const { sim, done } = run(fakeImage(200_000), { corruptBlock: 3 });
    await expect(done).rejects.toThrow(/Writing failed at 0xc00/);
    expect(sim.errors).toEqual(['bad checksum on command 0x57']);
    expect(sim.blocks).toBe(3);
  });

  it('times out when a write is never acknowledged', async () => {
    const { sim, done } = run(fakeImage(5000), { nakBlock: 2, nak: null });
    await expect(done).rejects.toThrow(/Writing failed at 0x800: the radio did not answer/);
    expect(sim.opened).toBe(false);
  });

  it('reports a port that cannot be opened', async () => {
    const sim = new SimRt4d();
    await sim.open({ baudRate: 9600 });
    await expect(flashRt4d(sim, fakeImage(100), quietContext(), fast)).rejects.toThrow(
      /Could not open the serial port/,
    );
    // The flasher did not open it, so it leaves it alone.
    expect(sim.opened).toBe(true);
  });
});

describe('the simulator rejects protocol mistakes', () => {
  /** Opens the simulator, writes raw bytes and returns what came back. */
  async function talk(sim: SimRt4d, chunks: number[][]): Promise<number[]> {
    await sim.open({ baudRate: 115200 });
    const writer = sim.writable!.getWriter();
    for (const chunk of chunks) await writer.write(Uint8Array.from(chunk));
    writer.releaseLock();
    const reader = sim.readable!.getReader();
    const got: number[] = [];
    for (;;) {
      const result = await Promise.race([
        reader.read(),
        new Promise<null>((r) => setTimeout(() => r(null), 5)),
      ]);
      if (!result || result.done) break;
      got.push(...result.value);
    }
    await reader.cancel();
    reader.releaseLock();
    await sim.close();
    return got;
  }
  /** Appends the checksum the bootloader wants. */
  const packet = (...bytes: number[]) => [...bytes, rt4dChecksum(Uint8Array.from(bytes))];
  const probe = packet(0x52, 0, 0);
  const erase = [packet(0x39, 0x33, 0x05, 0x10), packet(0x39, 0x33, 0x05, 0x55)];
  /** A write packet with the given offset field and a block of 0xA5. */
  const write = (hi: number, lo: number) => packet(0x57, hi, lo, ...new Array<number>(1024).fill(0xa5));

  it('answers the reference sequence', async () => {
    const sim = new SimRt4d({ probeReply: [0xff] });
    // The write goes out split across chunks, as a slow UART would deliver it.
    const block = write(0, 0);
    expect(await talk(sim, [probe, ...erase, block.slice(0, 500), block.slice(500)])).toEqual([
      0xff, 6, 6, 6,
    ]);
    expect(sim.errors).toEqual([]);
    expect(sim.flash.subarray(0, 1024).every((b) => b === 0xa5)).toBe(true);
    expect(sim.flash[1024]).toBe(0xff);
  });

  it('refuses a write before the erase', async () => {
    const sim = new SimRt4d({ probeReply: [0xff] });
    expect(await talk(sim, [probe, write(0, 0)])).toEqual([0xff, 0x15]);
    expect(sim.errors[0]).toMatch(/before the flash was erased/);
  });

  it('refuses a write after only one erase command, and erases out of order', async () => {
    const half = new SimRt4d({ probeReply: [0xff] });
    expect(await talk(half, [probe, erase[0], write(0, 0)])).toEqual([0xff, 6, 0x15]);
    const swapped = new SimRt4d({ probeReply: [0xff] });
    expect(await talk(swapped, [probe, erase[1]])).toEqual([0xff, 0x15]);
  });

  it('refuses commands before the probe', async () => {
    const sim = new SimRt4d();
    expect(await talk(sim, [erase[0]])).toEqual([0x15]);
    expect(sim.errors[0]).toMatch(/before the probe/);
  });

  it('refuses a block index instead of a byte offset', async () => {
    const sim = new SimRt4d({ probeReply: [0xff] });
    expect(await talk(sim, [probe, ...erase, write(0, 0), write(0, 1)])).toEqual([0xff, 6, 6, 6, 0x15]);
    expect(sim.errors[0]).toMatch(/offset field 0x1, expected 0x400/);
  });

  it('refuses a bad checksum and everything after it', async () => {
    const sim = new SimRt4d({ probeReply: [0xff] });
    const bad = [...erase[0]];
    bad[4] ^= 1;
    expect(await talk(sim, [probe, bad, erase[0]])).toEqual([0xff, 0x15, 0x15]);
    expect(sim.errors[0]).toMatch(/bad checksum/);
  });
});

describe('the fake serial port', () => {
  it('refuses to close while a stream is locked, like Chrome', async () => {
    const sim = new SimRt4d();
    await sim.open({ baudRate: 115200 });
    await expect(sim.open({ baudRate: 115200 })).rejects.toThrow(/already open/);
    const reader = sim.readable!.getReader();
    await expect(sim.close()).rejects.toThrow(/locked/);
    reader.releaseLock();
    const writer = sim.writable!.getWriter();
    await expect(sim.close()).rejects.toThrow(/locked/);
    writer.releaseLock();
    await sim.close();
    expect(sim.readable).toBeNull();
    expect(sim.writable).toBeNull();
    await expect(sim.close()).rejects.toThrow(/already closed/);
  });
});
