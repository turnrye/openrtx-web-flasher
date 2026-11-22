// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  flashRt950,
  rt950Crc,
  rt950ModelOf,
  rt950Packet,
  RT950_BLOCK_SIZE,
  RT950_MODEL,
  RT950_MODEL_OFFSET,
  type Rt950Options,
} from './rt950.ts';
import { FlashError, quietContext, type Progress } from './types.ts';
import { SimRt950, type SimRt950Options } from '../sim/rt950.ts';

/** Short timeouts and no pauses, so the failure cases do not wait for a real radio. */
const fast: Rt950Options = {
  probeTimeoutMs: 40,
  responseTimeoutMs: 40,
  dataTimeoutMs: 40,
  settleMs: 0,
  retryDelayMs: 1,
  quietMs: 2,
};

/** A synthetic .BTF: pseudo-random bytes with the model signature where the bootloader looks. */
function fakeBtf(length: number, model = RT950_MODEL, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed * 2654435761;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
  out.set(new TextEncoder().encode(model), RT950_MODEL_OFFSET);
  return out;
}

/** The file as the bootloader should have received it: zero-padded to whole blocks. */
function padded(btf: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(btf.length / RT950_BLOCK_SIZE) * RT950_BLOCK_SIZE);
  out.set(btf);
  return out;
}

/** Flashes `btf` into a fresh simulator and returns what happened. */
function run(btf: Uint8Array, simOptions: SimRt950Options = {}, options: Rt950Options = fast) {
  const sim = new SimRt950(simOptions);
  const seen: Progress[] = [];
  const log: string[] = [];
  const done = flashRt950(
    sim,
    btf,
    quietContext({ progress: (p) => seen.push(p), log: (m) => log.push(m) }),
    options,
  );
  return { sim, seen, log, done };
}

describe('rt950Crc and rt950Packet', () => {
  it('matches an answer captured from a radio', () => {
    // "aa 52 00 e1 00 00 c6 b0 55", quoted in the reference.
    expect(rt950Crc(Uint8Array.of(0x52, 0x00, 0xe1, 0x00, 0x00))).toBe(0xc6b0);
  });

  it('frames a command: header, command, argument, length, data, CRC, footer', () => {
    const packet = rt950Packet(0x03, 0x0102, Uint8Array.of(9, 8, 7));
    expect([...packet.subarray(0, 9)]).toEqual([0xaa, 0x03, 0x01, 0x02, 0x00, 0x03, 9, 8, 7]);
    const crc = rt950Crc(packet.subarray(1, 9));
    expect([...packet.subarray(9)]).toEqual([crc >> 8, crc & 0xff, 0x55]);
    expect(rt950Packet(0x42)).toHaveLength(9);
  });
});

describe('rt950ModelOf', () => {
  it('reads the model name, and gives null for a file too short to hold one', () => {
    expect(rt950ModelOf(fakeBtf(4096))).toBe(RT950_MODEL);
    expect(rt950ModelOf(new Uint8Array(100))).toBeNull();
  });
});

describe('flashRt950 against the simulated bootloader', () => {
  it('sends the file block by block and reports progress to the end', async () => {
    const btf = fakeBtf(70_000);
    const { sim, seen, log, done } = run(btf);
    await done;
    expect(sim.errors).toEqual([]);
    expect(sim.complete).toBe(true);
    expect(sim.probes).toBe(1);
    expect(sim.expected).toBe(69);
    expect(sim.arrivals).toEqual(Array.from({ length: 69 }, (_, i) => i));
    expect(Buffer.compare(sim.received, padded(btf))).toBe(0);

    expect(sim.opens).toEqual([
      { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' },
    ]);
    expect(sim.opened).toBe(false);
    expect(seen[0]).toEqual({ phase: 'connect', done: 0, total: 69 * 1024 });
    expect(seen.at(-1)).toEqual({ phase: 'done', done: 69 * 1024, total: 69 * 1024 });
    expect(log.join('\n')).toContain('Bootloader answered: ready');
    expect(log.join('\n')).toContain('Model "RT-950" accepted');
  });

  it('sends a file of whole blocks without padding', async () => {
    const btf = fakeBtf(8 * 1024);
    const { sim, done } = run(btf);
    await done;
    expect(sim.complete).toBe(true);
    expect(Buffer.compare(sim.received, btf)).toBe(0);
  });

  it('copes with answers that arrive a byte at a time and with noise before them', async () => {
    const btf = fakeBtf(5000);
    const { sim, done } = run(btf, { splitReplies: true, noise: [0x00, 0x41, 0x0d, 0x0a] });
    await done;
    expect(sim.errors).toEqual([]);
    expect(sim.complete).toBe(true);
  });

  it('goes on when the probe is not answered, as the reference does', async () => {
    const { sim, log, done } = run(fakeBtf(5000), { quietProbe: true });
    await done;
    expect(sim.complete).toBe(true);
    expect(log.join('\n')).toContain('No answer to the probe');
  });

  it('sends a block again when its answer is lost or says the length was wrong', async () => {
    const btf = fakeBtf(6 * 1024);
    for (const options of [{ dropBlock: 2 }, { lengthErrorBlock: 2 }, { loseAnswerBlock: 2 }]) {
      const { sim, log, done } = run(btf, options);
      await done;
      expect(sim.errors).toEqual([]);
      expect(sim.complete).toBe(true);
      expect(sim.arrivals).toEqual([0, 1, 2, 2, 3, 4, 5]);
      expect(Buffer.compare(sim.received, btf)).toBe(0);
      expect(log.join('\n')).toContain('Block 2:');
    }
  });

  it('gives up on a block after five attempts', async () => {
    const { sim, done } = run(fakeBtf(6 * 1024), { refuseBlock: 3 });
    await expect(done).rejects.toThrow(/block 3 of 6.*wrong data length/);
    expect(sim.arrivals.filter((n) => n === 3)).toHaveLength(5);
    expect(sim.complete).toBe(false);
    expect(sim.opened).toBe(false);
  });

  it('refuses a file that is not an RT-950 Pro .BTF before sending anything', async () => {
    for (const file of [new Uint8Array(100), fakeBtf(4096, 'RT-4D       '), new Uint8Array(4096)]) {
      const { sim, done } = run(file);
      await expect(done).rejects.toThrow(FlashError);
      await expect(done).rejects.toThrow(/not an RT-950 Pro \.BTF/);
      expect(sim.opens).toEqual([]);
    }
  });

  it('says so when the radio does not answer', async () => {
    const { sim, done } = run(fakeBtf(5000), { silent: true });
    await expect(done).rejects.toThrow(/did not answer. Is it connected and in flashing mode/);
    expect(sim.opened).toBe(false);
  });

  it('warns but finishes when the end command is answered with something else', async () => {
    const { sim, log, done } = run(fakeBtf(5000), { endResult: 0xe5 });
    await done;
    expect(sim.ended).toBe(true);
    expect(log.join('\n')).toContain('Warning: the radio answered "ready"');
  });

  it('reports a port that cannot be opened', async () => {
    const sim = new SimRt950();
    await sim.open({ baudRate: 9600 });
    await expect(flashRt950(sim, fakeBtf(5000), quietContext(), fast)).rejects.toThrow(
      /Could not open the serial port/,
    );
  });
});
