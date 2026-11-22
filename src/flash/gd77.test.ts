// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decodeGd77Frame,
  encodeGd77Frame,
  flashGd77,
  gd77Framing,
  parseSgl,
  type Gd77Model,
  type Gd77Options,
} from './gd77.ts';
import { FlashError, quietContext, type Progress } from './types.ts';
import { buildSgl, SimGd77, type SimGd77Options } from '../sim/gd77.ts';

/** Deterministic pseudo-random bytes standing in for a firmware binary. */
function fakeBin(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed * 2654435761;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

/** Flashes `sgl` into a fresh simulator and returns both. */
function run(
  sgl: Uint8Array,
  model: Gd77Model,
  simOptions: Partial<SimGd77Options> = {},
  options: Gd77Options = {},
) {
  const sim = new SimGd77({ model, ...simOptions });
  const seen: Progress[] = [];
  const log: string[] = [];
  const done = flashGd77(
    sim,
    sgl,
    model,
    quietContext({ progress: (p) => seen.push(p), log: (m) => log.push(m) }),
    {
      responseTimeoutMs: 50,
      ...options,
    },
  );
  return { sim, seen, log, done };
}

/** Checksum frames the script sends for `total` bytes: one per started kilobyte. */
const checksumsFor = (total: number) => Math.ceil(total / 1024);

describe('parseSgl', () => {
  it('reads length, key and model tag like the loader script', () => {
    const bin = fakeBin(300);
    const sgl = buildSgl(bin, 'GD-77', { payloadSize: 1000 });
    const parsed = parseSgl(sgl);
    expect(parsed.payload.length).toBe(1000);
    expect(Array.from(parsed.payload)).toEqual(Array.from(sgl.subarray(0x43a)));
    expect(String.fromCharCode(...parsed.key)).toBe('amnb');
    expect(parsed.modelTag).toBe(0x1b);
    expect(parsed.model).toBe('GD-77');

    const dm = parseSgl(buildSgl(bin, 'DM-1801'));
    expect(dm.payload.length).toBe(300);
    expect(String.fromCharCode(...dm.key)).toBe('t!D9');
    expect(dm.modelTag).toBe(0x4f);
    expect(dm.model).toBe('DM-1801');
  });

  it('rejects files that are not SGL or are damaged', () => {
    expect(() => parseSgl(fakeBin(2000))).toThrow(FlashError);
    expect(() => parseSgl(new Uint8Array(4))).toThrow(FlashError);
    const sgl = buildSgl(fakeBin(64), 'GD-77');
    expect(() => parseSgl(sgl.subarray(0, 0x100))).toThrow(/truncated/);
    // Cut just past the header fields: the length no longer fits what is left.
    expect(() => parseSgl(sgl.subarray(0, 0x150))).toThrow(/damaged/);
  });
});

describe('GD-77 HID framing', () => {
  it('puts the first wire byte in the report ID and pads to the report size', () => {
    const sim = new SimGd77({ model: 'GD-77' });
    const framing = gd77Framing(sim);
    expect(framing).toEqual({ numbered: true, outputReportId: 1, outputReportBytes: 41 });
    const { reportId, data } = encodeGd77Frame(framing, Uint8Array.from(Buffer.from('DOWNLOAD')));
    // On the wire: 01 00 08 00 "DOWNLOAD", as the Python script writes it.
    expect(reportId).toBe(0x01);
    expect(data.length).toBe(41);
    expect(Array.from(data.subarray(0, 11))).toEqual([
      0x00, 0x08, 0x00, 0x44, 0x4f, 0x57, 0x4e, 0x4c, 0x4f, 0x41, 0x44,
    ]);
    expect(data.subarray(11).every((b) => b === 0)).toBe(true);
  });

  it('falls back to report 0x01 of 41 bytes without a descriptor', () => {
    const sim = new SimGd77({ model: 'GD-77', hideDescriptor: true });
    expect(gd77Framing(sim)).toEqual({ numbered: true, outputReportId: 1, outputReportBytes: 41 });
    expect(gd77Framing(sim, { outputReportBytes: 63 }).outputReportBytes).toBe(63);
  });

  it('keeps the whole frame in the data for unnumbered reports', () => {
    const sim = new SimGd77({ model: 'GD-77', numberedReports: false });
    const framing = gd77Framing(sim);
    expect(framing).toEqual({ numbered: false, outputReportId: 0, outputReportBytes: 42 });
    const { reportId, data } = encodeGd77Frame(framing, Uint8Array.of(0x41));
    expect(reportId).toBe(0);
    expect(Array.from(data.subarray(0, 5))).toEqual([0x01, 0x00, 0x01, 0x00, 0x41]);
    expect(data.length).toBe(42);
  });

  it('strips the frame header from input reports either way', () => {
    const numbered = new DataView(Uint8Array.of(0x00, 0x01, 0x00, 0x41, 0x00).buffer);
    expect(Array.from(decodeGd77Frame(3, numbered))).toEqual([0x41, 0x00]);
    const plain = new DataView(Uint8Array.of(0x03, 0x00, 0x01, 0x00, 0x41, 0x00).buffer);
    expect(Array.from(decodeGd77Frame(0, plain))).toEqual([0x41, 0x00]);
  });
});

describe('flashGd77 against the simulated bootloader', () => {
  for (const model of ['GD-77', 'DM-1801'] as const) {
    it(`flashes a ${model}`, async () => {
      const sgl = buildSgl(fakeBin(5000), model, { payloadSize: 0x2001 });
      const { sim, seen, done } = run(sgl, model);
      await done;
      expect(sim.errors).toEqual([]);
      expect(sim.steps).toEqual([
        'DOWNLOAD',
        'ACK',
        'key',
        'F-PROG',
        'model 1',
        'model 2',
        'version',
        'F-ERASE',
        'post-erase ACK',
        'PROGRAM',
      ]);
      expect(sim.erased).toBe(true);
      expect(sim.complete).toBe(true);
      expect(Buffer.compare(sim.payload, parseSgl(sgl).payload)).toBe(0);
      expect(sim.checksums).toBe(checksumsFor(0x2001));
      expect(sim.opened).toBe(false);

      const last = seen[seen.length - 1];
      expect(last).toEqual({ phase: 'done', done: 0x2001, total: 0x2001 });
      const writes = seen.filter((p) => p.phase === 'write');
      expect(writes[writes.length - 1]).toEqual({ phase: 'write', done: 0x2001, total: 0x2001 });
      expect(writes.every((p, i) => i === 0 || p.done > writes[i - 1].done)).toBe(true);
      expect(seen.some((p) => p.phase === 'erase')).toBe(true);
    });
  }

  it('sends the key from the SGL header, and the simulator insists on it', async () => {
    const key = Uint8Array.from(Buffer.from('wxyz'));
    const sgl = buildSgl(fakeBin(100), 'GD-77', { key });
    const good = run(sgl, 'GD-77', { key });
    await good.done;
    expect(Buffer.compare(good.sim.payload, parseSgl(sgl).payload)).toBe(0);

    const bad = run(sgl, 'GD-77');
    await expect(bad.done).rejects.toThrow(/encryption key/);
    expect(bad.sim.errors[0]).toMatch(/key/);
    expect(bad.sim.payload.length).toBe(0);
  });

  for (const size of [1, 31, 32, 33, 64, 1000, 1023, 1024, 1025, 1056, 2048, 3001]) {
    it(`handles a ${size}-byte payload`, async () => {
      const sgl = buildSgl(fakeBin(size, size), 'DM-1801');
      const { sim, seen, done } = run(sgl, 'DM-1801');
      await done;
      expect(sim.errors).toEqual([]);
      expect(sim.complete).toBe(true);
      expect(Buffer.compare(sim.payload, parseSgl(sgl).payload)).toBe(0);
      expect(sim.checksums).toBe(checksumsFor(size));
      expect(seen[seen.length - 1]).toEqual({ phase: 'done', done: size, total: size });
    });
  }

  it('works over unnumbered reports and without a descriptor', async () => {
    const sgl = buildSgl(fakeBin(1500), 'GD-77');
    for (const simOptions of [{ numberedReports: false }, { hideDescriptor: true }]) {
      const { sim, done } = run(sgl, 'GD-77', simOptions);
      await done;
      expect(sim.errors).toEqual([]);
      expect(Buffer.compare(sim.payload, parseSgl(sgl).payload)).toBe(0);
    }
  });

  it('uses an already-open device and leaves it open', async () => {
    const sim = new SimGd77({ model: 'GD-77' });
    await sim.open();
    await flashGd77(sim, buildSgl(fakeBin(40), 'GD-77'), 'GD-77', quietContext());
    expect(sim.opened).toBe(true);
    expect(sim.complete).toBe(true);
  });

  it('refuses firmware for the other model before touching the radio', async () => {
    const sgl = buildSgl(fakeBin(100), 'DM-1801');
    const { sim, done } = run(sgl, 'GD-77');
    await expect(done).rejects.toThrow(FlashError);
    await expect(done).rejects.toThrow(/DM-1801/);
    expect(sim.sent.length).toBe(0);
  });

  it('fails when the radio is the other model', async () => {
    const sgl = buildSgl(fakeBin(100), 'GD-77');
    const sim = new SimGd77({ model: 'DM-1801' });
    const done = flashGd77(sim, sgl, 'GD-77', quietContext(), { responseTimeoutMs: 50 });
    await expect(done).rejects.toThrow(FlashError);
    expect(sim.errors[0]).toMatch(/key/);
    expect(sim.erased).toBe(false);
    expect(sim.payload.length).toBe(0);
    expect(sim.opened).toBe(false);
  });

  it('fails on a corrupted response in the handshake', async () => {
    const sgl = buildSgl(fakeBin(100), 'GD-77');
    const { sim, done } = run(sgl, 'GD-77', { corruptResponseAt: 0 });
    await expect(done).rejects.toThrow(/Unexpected response.*download command/);
    expect(sim.steps).toEqual(['DOWNLOAD']);
  });

  it('fails on a corrupted response in the data phase', async () => {
    const sgl = buildSgl(fakeBin(4096), 'GD-77');
    // 10 handshake answers, then the answer to the 21st data frame.
    const { sim, seen, done } = run(sgl, 'GD-77', { corruptResponseAt: 10 + 20 });
    await expect(done).rejects.toThrow(/Unexpected response.*0x280/);
    expect(sim.payload.length).toBe(21 * 32);
    expect(seen.some((p) => p.phase === 'done')).toBe(false);
  });

  it('times out when the radio stops answering', async () => {
    const sgl = buildSgl(fakeBin(100), 'GD-77');
    const first = run(sgl, 'GD-77', { dropResponseAt: 0 }, { responseTimeoutMs: 20 });
    await expect(first.done).rejects.toThrow(/No response/);
    const later = run(sgl, 'GD-77', { dropResponseAt: 12 }, { responseTimeoutMs: 20 });
    await expect(later.done).rejects.toThrow(/No response/);
    expect(later.sim.opened).toBe(false);
  });

  it('fails when the simulator goes silent on a protocol error', async () => {
    const sgl = buildSgl(fakeBin(100), 'GD-77');
    const { sim, done } = run(
      sgl,
      'GD-77',
      { model: 'DM-1801', onError: 'silent' },
      { responseTimeoutMs: 20 },
    );
    await expect(done).rejects.toThrow(/No response/);
    expect(sim.errors.length).toBe(1);
  });

  it('refuses a payload larger than the script allows', async () => {
    const sgl = buildSgl(new Uint8Array(0), 'GD-77', { payloadSize: 0x7b001 });
    const { sim, done } = run(sgl, 'GD-77');
    await expect(done).rejects.toThrow(/too large/);
    expect(sim.sent.length).toBe(0);
  });
});

describe('the simulator rejects protocol mistakes', () => {
  /** Sends raw frames through the real framing and collects the answers. */
  async function talk(sim: SimGd77, frames: Uint8Array[]): Promise<number[][]> {
    const answers: number[][] = [];
    sim.addEventListener('inputreport', (e) => {
      const payload = decodeGd77Frame(e.reportId, e.data);
      answers.push(Array.from(payload.subarray(0, 8)));
    });
    await sim.open();
    for (const frame of frames) {
      const { reportId, data } = encodeGd77Frame(gd77Framing(sim), frame);
      await sim.sendReport(reportId, data);
      await Promise.resolve();
    }
    return answers;
  }
  /** ASCII bytes of `s`, padded with 0xFF to `length`. */
  const bytes = (s: string, length = s.length) => {
    const out = new Uint8Array(length).fill(0xff);
    out.set(Buffer.from(s, 'latin1'));
    return out;
  };
  /** The ten handshake commands of the script, for a GD-77. */
  const handshake = [
    bytes('DOWNLOAD'),
    bytes('A'),
    bytes('DV01amnb'),
    bytes('F-PROG', 8),
    bytes('SG-MD-760', 16),
    bytes('MD-760', 8),
    bytes('V1.00.01'),
    bytes('F-ERASE', 8),
    bytes('A'),
    bytes('PROGRAM\x0f'),
  ];
  /** One data frame: big-endian address and length, then 32 bytes. */
  const dataFrame = (address: number, length: number, fill: number) => {
    const out = new Uint8Array(38).fill(fill);
    new DataView(out.buffer).setUint32(0, address);
    new DataView(out.buffer).setUint16(4, length);
    return out;
  };
  /** One checksum frame. */
  const checksum = (sum: number) => {
    const out = new Uint8Array(8);
    out.set([0x45, 0x4e, 0x44, 0xff]);
    new DataView(out.buffer).setUint32(4, sum, true);
    return out;
  };

  it('accepts the script handshake byte for byte', async () => {
    const sim = new SimGd77({ model: 'GD-77' });
    const answers = await talk(sim, handshake);
    expect(sim.errors).toEqual([]);
    expect(String.fromCharCode(...answers[0])).toBe('#UPDATE?');
    expect(answers[2]).toEqual([0x44, 0x56, 0x30, 0x31, 0, 0, 0, 0]);
    expect(answers[9]).toEqual([0x41, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('rejects steps out of order', async () => {
    const sim = new SimGd77({ model: 'GD-77' });
    await talk(sim, [handshake[0], handshake[1], handshake[3]]);
    expect(sim.errors[0]).toMatch(/"key"/);
  });

  it('rejects 0xFF-padded PROGRAM, which the script does not send', async () => {
    const sim = new SimGd77({ model: 'GD-77' });
    await talk(sim, [...handshake.slice(0, 9), bytes('PROGRAM', 8)]);
    expect(sim.errors[0]).toMatch(/PROGRAM/);
  });

  it('rejects a skipped address', async () => {
    const sim = new SimGd77({ model: 'GD-77' });
    await talk(sim, [...handshake, dataFrame(0, 32, 1), dataFrame(64, 32, 1)]);
    expect(sim.errors[0]).toMatch(/expected 0x20/);
  });

  it('rejects a wrong checksum and a missing one', async () => {
    const wrong = new SimGd77({ model: 'GD-77' });
    await talk(wrong, [...handshake, dataFrame(0, 5, 1), checksum(6)]);
    expect(wrong.errors[0]).toMatch(/checksum/);

    const missing = new SimGd77({ model: 'GD-77' });
    const block = Array.from({ length: 33 }, (_, i) => dataFrame(i * 32, 32, 1));
    await talk(missing, [...handshake, ...block]);
    expect(missing.errors[0]).toMatch(/checksum was due/);
    expect(missing.complete).toBe(false);
  });

  it('rejects data after the final checksum', async () => {
    const sim = new SimGd77({ model: 'GD-77' });
    await talk(sim, [...handshake, dataFrame(0, 5, 1), checksum(5), dataFrame(5, 32, 1)]);
    expect(sim.errors[0]).toMatch(/after the final checksum/);
  });

  it('rejects unpadded and wrongly numbered reports', async () => {
    const short = new SimGd77({ model: 'GD-77' });
    await short.open();
    await short.sendReport(1, Uint8Array.of(0, 8, 0, ...handshake[0]));
    expect(short.errors[0]).toMatch(/11 bytes/);

    const wrongId = new SimGd77({ model: 'GD-77' });
    await wrongId.open();
    await wrongId.sendReport(2, encodeGd77Frame(gd77Framing(wrongId), handshake[0]).data);
    expect(wrongId.errors[0]).toMatch(/report ID 2/);
    await expect(wrongId.sendReport(9, new Uint8Array(41))).rejects.toThrow(/Failed to write/);
  });
});

const releaseDir = process.env.ORTX_RELEASE_DIR;

describe.skipIf(!releaseDir)('flashGd77 with OpenRTX release files', () => {
  const cases: [file: string, model: Gd77Model, length: number, key: string, tag: number][] = [
    ['openrtx_gd77_v0.4.5.sgl', 'GD-77', 0x77001, 'amnb', 0x1b],
    ['openrtx_dm1801_v0.4.5.sgl', 'DM-1801', 0x78001, 't!D9', 0x4f],
  ];

  for (const [file, model, length, key, tag] of cases) {
    it(`flashes ${file}`, async () => {
      const sgl = new Uint8Array(readFileSync(join(releaseDir!, file)));
      const parsed = parseSgl(sgl);
      expect(parsed.payload.length).toBe(length);
      expect(String.fromCharCode(...parsed.key)).toBe(key);
      expect(parsed.modelTag).toBe(tag);
      expect(parsed.model).toBe(model);

      const { sim, seen, done } = run(sgl, model, {}, { responseTimeoutMs: 5000 });
      await done;
      expect(sim.errors).toEqual([]);
      expect(sim.complete).toBe(true);
      expect(Buffer.compare(sim.payload, sgl.subarray(sgl.length - length))).toBe(0);
      expect(sim.checksums).toBe(checksumsFor(length));
      expect(seen[seen.length - 1]).toEqual({ phase: 'done', done: length, total: length });
    });
  }

  it('refuses the GD-77 file for a DM-1801 and the other way round', async () => {
    const gd77 = new Uint8Array(readFileSync(join(releaseDir!, cases[0][0])));
    const dm1801 = new Uint8Array(readFileSync(join(releaseDir!, cases[1][0])));
    await expect(run(gd77, 'DM-1801').done).rejects.toThrow(/GD-77/);
    await expect(run(dm1801, 'GD-77').done).rejects.toThrow(/DM-1801/);
  });
});
