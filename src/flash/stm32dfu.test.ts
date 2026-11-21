// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flashDfuSe, parseDfuFile, rawSegment, readDfuSe, type DfuSeOptions } from './stm32dfu.ts';
import { FlashError, quietContext, type Progress, type Segment } from './types.ts';
import { SimStm32Dfu, type SimStm32Options } from '../sim/stm32dfu.ts';

const RELEASE_DIR = process.env.ORTX_RELEASE_DIR;

/** Random bytes as a plain Uint8Array. */
function random(length: number): Uint8Array {
  return new Uint8Array(randomBytes(length));
}

/** Flashes segments into a fresh simulated ROM and returns what happened. */
async function flashSim(segments: Segment[], simOptions: SimStm32Options = {}, opts?: DfuSeOptions) {
  const sim = new SimStm32Dfu(simOptions);
  sim.flash.fill(0x00); // "old firmware" everywhere, so missing or extra erases show
  const progress: Progress[] = [];
  const logs: string[] = [];
  const ctx = quietContext({ sleep: sim.sleep, log: (m) => logs.push(m), progress: (p) => progress.push(p) });
  let error: unknown = null;
  try {
    await flashDfuSe(sim, segments, ctx, opts);
  } catch (e) {
    error = e;
  }
  return { sim, progress, logs, error };
}

/** Last progress report of a phase. */
function last(progress: Progress[], phase: Progress['phase']): Progress | undefined {
  return progress.filter((p) => p.phase === phase).at(-1);
}

/** CRC-32 register without the final inversion, as the DFU suffix stores it. */
function dfuCrc(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return crc >>> 0;
}

/** Builds a DfuSe .dfu file the way scripts/dfu-convert.py does. */
function buildDfu(targets: Segment[][], alt = 0): Uint8Array {
  const u32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  const body: number[] = [];
  for (const elements of targets) {
    const data: number[] = [];
    for (const e of elements) data.push(...u32(e.address), ...u32(e.data.length), ...e.data);
    const name = [...Buffer.from('ST...'), ...new Array<number>(250).fill(0)];
    body.push(
      ...Buffer.from('Target'),
      alt,
      ...u32(1),
      ...name,
      ...u32(data.length),
      ...u32(elements.length),
      ...data,
    );
  }
  const file = [...Buffer.from('DfuSe'), 1, ...u32(body.length + 11), targets.length, ...body];
  file.push(0, 0, 0x11, 0xdf, 0x83, 0x04, 0x1a, 0x01, ...Buffer.from('UFD'), 16);
  file.push(...u32(dfuCrc(Uint8Array.from(file))));
  return Uint8Array.from(file);
}

/** Rewrites the CRC after a test has tampered with a .dfu file. */
function fixCrc(file: Uint8Array): Uint8Array {
  new DataView(file.buffer).setUint32(file.length - 4, dfuCrc(file.subarray(0, file.length - 4)), true);
  return file;
}

describe('flashDfuSe on a simulated STM32F405 ROM', () => {
  it('writes a segment spanning several sectors and verifies it', async () => {
    const data = random(2 * 0x4000 + 777); // three 16K sectors, not a multiple of 2048
    const { sim, progress, error } = await flashSim([rawSegment(0x08000000, data)]);
    expect(error).toBeNull();
    expect(sim.violations).toEqual([]);
    expect(sim.read(0x08000000, data.length)).toEqual(data);
    // the rest of the third sector was erased, the fourth was not touched
    expect(sim.read(0x08000000 + data.length, 3 * 0x4000 - data.length).every((b) => b === 0xff)).toBe(true);
    expect(sim.flash.subarray(3 * 0x4000).every((b) => b === 0x00)).toBe(true);

    expect(last(progress, 'erase')).toEqual({ phase: 'erase', done: 3 * 0x4000, total: 3 * 0x4000 });
    expect(last(progress, 'write')).toEqual({ phase: 'write', done: data.length, total: data.length });
    expect(last(progress, 'verify')).toEqual({ phase: 'verify', done: data.length, total: data.length });
    expect(progress.at(-1)).toEqual({ phase: 'done', done: data.length, total: data.length });
    expect(sim.startedAt).toBeNull();
    expect(sim.opened).toBe(false);
  });

  it('reports progress in order and never backwards', async () => {
    const { progress } = await flashSim([rawSegment(0x08008000, random(70000))]);
    const phases = progress.map((p) => p.phase).filter((p, i, all) => p !== all[i - 1]);
    expect(phases).toEqual(['connect', 'erase', 'write', 'verify', 'done']);
    for (let i = 1; i < progress.length; i++) {
      if (progress[i].phase === progress[i - 1].phase) {
        expect(progress[i].done).toBeGreaterThanOrEqual(progress[i - 1].done);
      }
      expect(progress[i].done).toBeLessThanOrEqual(progress[i].total);
    }
  });

  it('uses the block numbering the ROM expects', async () => {
    const data = random(2048 * 2 + 10);
    const { sim } = await flashSim([rawSegment(0x08004000, data)]);
    const downloads = sim.requests.filter((r) => r.startsWith('DNLOAD'));
    expect(downloads).toEqual([
      'DNLOAD 0 len=5', // erase 0x08004000
      'DNLOAD 0 len=5', // set address
      'DNLOAD 2 len=2048',
      'DNLOAD 3 len=2048',
      'DNLOAD 4 len=10',
      'DNLOAD 0 len=5', // set address for the read-back
    ]);
    expect(sim.requests.filter((r) => r.startsWith('UPLOAD'))).toEqual([
      'UPLOAD 2 len=2048',
      'UPLOAD 3 len=2048',
      'UPLOAD 4 len=10',
    ]);
  });

  it('writes several segments and erases a shared sector once', async () => {
    const a = random(5000);
    const b = random(3000);
    const c = random(0x20000 + 1);
    const segments = [rawSegment(0x08010000, a), rawSegment(0x08018000, b), rawSegment(0x08040000, c)];
    const { sim, error } = await flashSim(segments);
    expect(error).toBeNull();
    expect(sim.violations).toEqual([]);
    expect(sim.read(0x08010000, a.length)).toEqual(a);
    expect(sim.read(0x08018000, b.length)).toEqual(b);
    expect(sim.read(0x08040000, c.length)).toEqual(c);
    const erases = sim.requests.filter((r) => r === 'DNLOAD 0 len=5').length;
    expect(erases).toBe(3 + 3 + 3); // 3 sectors, then a set-address per segment for write and verify
    expect(sim.read(0x08020000, 16).every((x) => x === 0x00)).toBe(true); // sector between them untouched
  });

  it('detects a verify mismatch', async () => {
    const data = random(10000);
    const { error, progress } = await flashSim([rawSegment(0x08000000, data)], {
      corruptAt: 0x08000000 + 4321,
    });
    expect(error).toBeInstanceOf(FlashError);
    expect((error as Error).message).toMatch(
      /^Verify failed at 0x080010e1: wrote 0x[0-9a-f]{2}, read back 0x[0-9a-f]{2}\.$/,
    );
    expect(last(progress, 'done')).toBeUndefined();
  });

  it('explains a read-protected chip', async () => {
    const { error } = await flashSim([rawSegment(0x08000000, random(100))], { readProtected: true });
    expect((error as Error).message).toMatch(/read-protected/);
  });

  it('leaves DFU mode at the firmware address when asked', async () => {
    const data = random(3000);
    const { sim, error } = await flashSim(
      [rawSegment(0x08010000, data), rawSegment(0x08004000, data)],
      {},
      { leave: true },
    );
    expect(error).toBeNull();
    expect(sim.violations).toEqual([]);
    expect(sim.startedAt).toBe(0x08004000);
    expect(sim.requests.slice(-2)).toEqual(['DNLOAD 0 len=0', 'GETSTATUS']);
  });

  it('leaves at an explicit address', async () => {
    const { sim } = await flashSim(
      [rawSegment(0x08010000, random(64))],
      {},
      { leave: true, leaveAddress: 0x08000000 },
    );
    expect(sim.startedAt).toBe(0x08000000);
  });

  it('refuses firmware that does not fit before touching the flash', async () => {
    const { sim, error } = await flashSim([rawSegment(0x080f0000, random(0x10001))]);
    expect((error as Error).message).toMatch(/does not fit this device: 0x08100000/);
    expect(sim.requests.filter((r) => r.startsWith('DNLOAD'))).toEqual([]);
    expect(sim.flash.every((b) => b === 0x00)).toBe(true);
  });

  it('refuses an empty firmware', async () => {
    const { error } = await flashSim([rawSegment(0x08000000, new Uint8Array(0))]);
    expect(error).toBeInstanceOf(FlashError);
  });

  it('recovers a device left in dfuERROR', async () => {
    const sim = new SimStm32Dfu();
    await sim.open();
    await sim.selectConfiguration(1);
    await sim.claimInterface(0);
    const bad = { requestType: 'class', recipient: 'interface', request: 1, value: 1, index: 0 } as const;
    expect((await sim.controlTransferOut(bad, Uint8Array.of(0))).status).toBe('stall');
    sim.violations.length = 0;
    const data = random(500);
    await flashDfuSe(sim, [rawSegment(0x08000000, data)], quietContext({ sleep: sim.sleep }));
    expect(sim.read(0x08000000, 500)).toEqual(data);
    expect(sim.violations).toEqual([]);
  });

  it('works on a GD32 ROM with its own IDs', async () => {
    const data = random(4097);
    const { sim, error } = await flashSim([rawSegment(0x08000000, data)], {
      vendorId: 0x28e9,
      productId: 0x0189,
    });
    expect(error).toBeNull();
    expect(sim.vendorId).toBe(0x28e9);
    expect(sim.read(0x08000000, data.length)).toEqual(data);
  });
});

describe('readDfuSe, for backups', () => {
  for (const chip of ['f405', 'h743'] as const) {
    it(`reads the whole flash of an ${chip} and the result restores it`, async () => {
      const sim = new SimStm32Dfu({ chip });
      const old = random(sim.flash.length);
      sim.flash.set(old);
      const progress: Progress[] = [];
      const ctx = quietContext({ sleep: sim.sleep, progress: (p) => progress.push(p) });

      const backup = await readDfuSe(sim, ctx, { chip });
      expect(backup.address).toBe(0x08000000);
      expect(backup.data.length).toBe(chip === 'h743' ? 2 * 1024 * 1024 : 1024 * 1024);
      expect(Buffer.compare(backup.data, old)).toBe(0);
      expect(last(progress, 'read')).toEqual({ phase: 'read', done: old.length, total: old.length });
      // Reading changes nothing and makes no protocol mistakes.
      expect(Buffer.compare(sim.flash, old)).toBe(0);
      expect(sim.violations).toEqual([]);

      // Overwrite the radio, then put the backup back.
      await flashDfuSe(sim, [rawSegment(0x08000000, random(200 * 1024))], ctx, { chip });
      expect(Buffer.compare(sim.flash, old)).not.toBe(0);
      await flashDfuSe(sim, [backup], ctx, { chip });
      expect(Buffer.compare(sim.flash, old)).toBe(0);
      expect(sim.violations).toEqual([]);
    });
  }

  it('reads with the built-in layout when the device reports none', async () => {
    const sim = new SimStm32Dfu({ alternateNames: [null], serveDescriptors: false });
    const old = random(sim.flash.length);
    sim.flash.set(old);
    const logs: string[] = [];
    const backup = await readDfuSe(sim, quietContext({ sleep: sim.sleep, log: (m) => logs.push(m) }));
    expect(Buffer.compare(backup.data, old)).toBe(0);
    expect(logs.join('\n')).toMatch(/built-in STM32F405/);
  });

  it('says so when the chip is read-protected, and leaves it untouched', async () => {
    const sim = new SimStm32Dfu({ readProtected: true });
    const old = random(sim.flash.length);
    sim.flash.set(old);
    await expect(readDfuSe(sim, quietContext({ sleep: sim.sleep }))).rejects.toThrow(/read-protected/);
    expect(Buffer.compare(sim.flash, old)).toBe(0);
  });
});

describe('flashDfuSe layout and block size fallbacks', () => {
  it('flashes an STM32H743 above 1 MiB with 1024-byte blocks', async () => {
    const data = random(0x20000 + 555);
    const { sim, error, progress } = await flashSim([rawSegment(0x08100000, data)], { chip: 'h743' });
    expect(error).toBeNull();
    expect(sim.violations).toEqual([]);
    expect(sim.read(0x08100000, data.length)).toEqual(data);
    expect(last(progress, 'erase')?.total).toBe(2 * 0x20000);
    expect(sim.requests).toContain('DNLOAD 2 len=1024');
    expect(sim.flash.subarray(0, 0x100000).every((b) => b === 0x00)).toBe(true);
  });

  it('uses the built-in F405 layout and 2048-byte blocks without descriptors', async () => {
    const data = random(0x4000 + 100);
    const { sim, error, logs } = await flashSim([rawSegment(0x0800c000, data)], {
      exposeInterfaceNames: false,
      serveDescriptors: false,
    });
    expect(error).toBeNull();
    expect(sim.violations).toEqual([]);
    expect(logs.join('\n')).toMatch(/built-in STM32F405/);
    expect(sim.read(0x0800c000, data.length)).toEqual(data);
    expect(sim.requests).toContain('DNLOAD 2 len=2048');
    expect(sim.read(0x08008000, 16).every((b) => b === 0x00)).toBe(true);
  });

  it('guesses the H743 layout for firmware above 1 MiB, and takes a chip hint', async () => {
    const noDescriptors = {
      chip: 'h743',
      transferSize: 2048,
      exposeInterfaceNames: false,
      serveDescriptors: false,
    } as const;
    const high = await flashSim([rawSegment(0x08100000, random(5000))], noDescriptors);
    expect(high.error).toBeNull();
    expect(high.logs.join('\n')).toMatch(/built-in STM32H743/);

    const data = random(5000);
    const low = await flashSim([rawSegment(0x08000000, data)], noDescriptors, { chip: 'h743' });
    expect(low.error).toBeNull();
    expect(low.sim.violations).toEqual([]);
    expect(low.sim.read(0x08000000, 5000)).toEqual(data);
    expect(low.sim.requests.filter((r) => r === 'DNLOAD 0 len=5')).toHaveLength(3); // one erase, two set-address
  });
});

describe('parseDfuFile', () => {
  it('parses a single-element file', () => {
    const data = random(1000);
    expect(parseDfuFile(buildDfu([[rawSegment(0x08000000, data)]]))).toEqual([{ address: 0x08000000, data }]);
  });

  it('parses several elements and targets in order', () => {
    const a = random(10);
    const b = random(0);
    const c = random(4096);
    const file = buildDfu([
      [rawSegment(0x08000000, a), rawSegment(0x08004000, b)],
      [rawSegment(0x08100000, c)],
    ]);
    expect(parseDfuFile(file)).toEqual([
      { address: 0x08000000, data: a },
      { address: 0x08004000, data: b },
      { address: 0x08100000, data: c },
    ]);
  });

  it('round-trips through the flasher', async () => {
    const data = random(9000);
    const segments = parseDfuFile(buildDfu([[rawSegment(0x08020000, data)]]));
    const { sim, error } = await flashSim(segments);
    expect(error).toBeNull();
    expect(sim.read(0x08020000, data.length)).toEqual(data);
  });

  it('rejects malformed files', () => {
    const good = buildDfu([[rawSegment(0x08000000, random(64))]]);
    const tamper = (change: (copy: Uint8Array) => void, recrc = true) => {
      const copy = good.slice();
      change(copy);
      return recrc ? fixCrc(copy) : copy;
    };
    const view = (copy: Uint8Array) => new DataView(copy.buffer);

    expect(() => parseDfuFile(new Uint8Array(0))).toThrow(FlashError);
    expect(() => parseDfuFile(random(20))).toThrow(/too short/);
    expect(() => parseDfuFile(random(500))).toThrow(/signature is missing/);
    expect(() => parseDfuFile(tamper((c) => (c[0] = 0x64)))).toThrow(/"DfuSe" signature/);
    expect(() => parseDfuFile(tamper((c) => (c[5] = 2)))).toThrow(/version 2/);
    expect(() => parseDfuFile(good.subarray(0, good.length - 1))).toThrow(/suffix is missing/);
    expect(() => parseDfuFile(good.subarray(0, 200))).toThrow(FlashError);
    expect(() => parseDfuFile(tamper((c) => (c[c.length - 8] = 0x58)))).toThrow(/suffix is missing/);
    expect(() => parseDfuFile(tamper((c) => view(c).setUint32(6, 5, true)))).toThrow(/image size/);
    expect(() => parseDfuFile(tamper((c) => (c[300] ^= 0xff), false))).toThrow(/checksum/);
    expect(() => parseDfuFile(tamper((c) => (c[11] = 0x74)))).toThrow(/target 0 has a bad signature/);
    expect(() => parseDfuFile(tamper((c) => (c[17] = 1)))).toThrow(/alternate setting 1/);
    expect(() => parseDfuFile(tamper((c) => view(c).setUint32(277, 9999, true)))).toThrow(
      /larger than the file/,
    );
    expect(() => parseDfuFile(tamper((c) => view(c).setUint32(289, 65, true)))).toThrow(
      /larger than its target/,
    );
    expect(() => parseDfuFile(tamper((c) => view(c).setUint32(289, 63, true)))).toThrow(
      /after its last element/,
    );
    expect(() => parseDfuFile(tamper((c) => view(c).setUint32(281, 2, true)))).toThrow(
      /element 1 of target 0 is truncated/,
    );
    expect(() => parseDfuFile(tamper((c) => (c[10] = 2)))).toThrow(/target 1 is truncated/);
    expect(() => parseDfuFile(tamper((c) => (c[10] = 0)))).toThrow(/after the last target/);
    expect(() => parseDfuFile(buildDfu([]))).toThrow(/holds no firmware/);
    expect(() => parseDfuFile(buildDfu([[rawSegment(0x1fffc000, random(16))]], 1))).toThrow(
      /alternate setting 1/,
    );
  });
});

describe.skipIf(!RELEASE_DIR)('OpenRTX v0.4.5 release files on the simulated ROM', () => {
  const file = (name: string) => new Uint8Array(readFileSync(join(RELEASE_DIR ?? '', name)));

  it('flashes the CS7000 .dfu to an STM32F405 at 0x08000000', async () => {
    const segments = parseDfuFile(file('openrtx_cs7000_v0.4.5.dfu'));
    const bin = file('openrtx_cs7000_v0.4.5.bin');
    expect(segments).toHaveLength(1);
    expect(segments[0].address).toBe(0x08000000);
    expect(segments[0].data).toEqual(bin);
    const { sim, error, progress } = await flashSim(segments, { chip: 'f405' }, { leave: true });
    expect(error).toBeNull();
    expect(sim.violations).toEqual([]);
    expect(sim.read(0x08000000, bin.length)).toEqual(bin);
    expect(last(progress, 'verify')).toEqual({ phase: 'verify', done: bin.length, total: bin.length });
    expect(sim.startedAt).toBe(0x08000000);
  });

  it('flashes the CS7000-PLUS .dfu to an STM32H743 at 0x08100000', async () => {
    const segments = parseDfuFile(file('openrtx_cs7000p_v0.4.5.dfu'));
    expect(segments.map((s) => [s.address, s.data.length])).toEqual([[0x08100000, 217440]]);
    const { sim, error, progress } = await flashSim(segments, { chip: 'h743' });
    expect(error).toBeNull();
    expect(sim.violations).toEqual([]);
    expect(sim.read(0x08100000, 217440)).toEqual(segments[0].data);
    expect(sim.flash.subarray(0, 0x100000).every((b) => b === 0x00)).toBe(true); // bootloader half untouched
    expect(last(progress, 'erase')?.total).toBe(2 * 0x20000);
    expect(progress.at(-1)).toEqual({ phase: 'done', done: 217440, total: 217440 });
  });

  it('flashes the raw Module17 binary to an STM32F405 at 0x08000000', async () => {
    const bin = file('openrtx_mod17_v0.4.5.bin');
    const { sim, error } = await flashSim([rawSegment(0x08000000, bin)], { chip: 'f405' });
    expect(error).toBeNull();
    expect(sim.violations).toEqual([]);
    expect(sim.read(0x08000000, bin.length)).toEqual(bin);
    expect(sim.flash.subarray(0x40000).every((b) => b === 0x00)).toBe(true);
  });
});
