// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DfuDevice } from './dfu.ts';
import { flashTyt, parseTytFirmware } from './tyt.ts';
import { FlashError, quietContext, type Progress, type Segment } from './types.ts';
import { SimStm32Dfu } from '../sim/stm32dfu.ts';
import { SimTytRadio, TYT_ORIGINAL_NAMES, type TytOp } from '../sim/tyt.ts';

const RELEASE_DIR = process.env.ORTX_RELEASE_DIR;
const UV3X0 = [0x02, 0x17, 0x0c];
const MD380 = [0x01, 0x0d];

/** Random bytes as a plain Uint8Array. */
function random(length: number): Uint8Array {
  return new Uint8Array(randomBytes(length));
}

/** Builds a TYT-wrapped firmware file the way radio_tool's TYTFW::Write does. */
function buildTyt(regions: Segment[], magic = UV3X0, model = 'MD-9600'): Uint8Array {
  const total = regions.reduce((sum, r) => sum + r.data.length, 0);
  const file = new Uint8Array(0x100 + total + 0x100).fill(0xff);
  const view = new DataView(file.buffer);
  file.fill(0, 0, 0x30);
  file.set(Buffer.from('OutSecurityBin'), 0);
  file.set(Buffer.from(model), 0x10);
  view.setUint32(0x20, 0x30000230, true);
  view.setUint32(0x24, 0x47004000, true);
  for (let i = 0; i <= 0x20; i++) file[0x30 + i] = i;
  file.set(magic, 0x30);
  view.setUint32(0x7c, regions.length, true);
  let offset = 0x100;
  regions.forEach((r, i) => {
    view.setUint32(0x80 + i * 8, r.address, true);
    view.setUint32(0x84 + i * 8, r.data.length, true);
    file.set(r.data, offset);
    offset += r.data.length;
  });
  file.set(Buffer.from('OutputBinDataEnd'), file.length - 16);
  return file;
}

/**
 * The downloads radio_tool makes for these regions: a line-by-line transcription of
 * TYTRadio::WriteFirmware and FlashUtil::AlignedContiguousMemoryOp, kept separate from
 * the flasher so the two can disagree.
 */
function radioToolOps(regions: Segment[]): TytOp[] {
  const sectors: [number, number][] = [
    [0x08000000, 0x4000],
    [0x08004000, 0x4000],
    [0x08008000, 0x4000],
    [0x0800c000, 0x4000],
    [0x08010000, 0x10000],
    [0x08020000, 0x20000],
    [0x08040000, 0x20000],
    [0x08060000, 0x20000],
    [0x08080000, 0x20000],
    [0x080a0000, 0x20000],
    [0x080c0000, 0x20000],
    [0x080e0000, 0x20000],
  ];
  const aligned = (start: number, end: number, fn: (addr: number, size: number) => void) => {
    for (let addr = start; addr < end;) {
      const sec = sectors.find(([s, n]) => addr >= s && addr < s + n);
      if (!sec) break;
      const nBytes = Math.min(end, sec[0] + sec[1]) - addr;
      fn(addr, nBytes);
      addr += nBytes;
    }
  };
  const ops: TytOp[] = [{ op: 'command', code: 0x31 }];
  for (const r of regions) {
    const size = r.data.length;
    aligned(r.address, r.address + size, (addr) => ops.push({ op: 'erase', address: addr }));
    let bOffset = 0;
    aligned(r.address, r.address + size, (addr, n) => {
      const blocks = Math.ceil(n / 1024);
      ops.push({ op: 'setAddress', address: addr });
      for (let wValue = 0; wValue < blocks; wValue++) {
        const blockOffset = bOffset + 1024 * wValue;
        const length = Math.min(1024, size - blockOffset);
        ops.push({ op: 'write', block: 2 + wValue, address: addr + 1024 * wValue, length });
      }
      bOffset += n;
    });
  }
  return ops;
}

/** Flashes a wrapped file into a fresh simulated radio and returns what happened. */
async function flashSim(wrapped: Uint8Array, sim: SimStm32Dfu = new SimTytRadio()) {
  const progress: Progress[] = [];
  const logs: string[] = [];
  let slept = 0;
  const ctx = quietContext({
    log: (m) => logs.push(m),
    progress: (p) => progress.push(p),
    sleep: async (ms) => void (slept += ms),
  });
  let error: unknown = null;
  try {
    await flashTyt(sim, wrapped, ctx);
  } catch (e) {
    error = e;
  }
  return { sim, progress, logs, error, slept: () => slept };
}

/** Asserts every DNLOAD was wrapped the way radio_tool's DFU::Download does it. */
function expectRadioToolPattern(requests: string[]): void {
  expect(requests.length % 4).toBe(0);
  for (let i = 0; i < requests.length; i += 4) {
    expect(requests[i]).toBe('GETSTATE');
    expect(requests[i + 1]).toMatch(/^DNLOAD /);
    expect(requests[i + 2]).toBe('GETSTATUS');
    expect(requests[i + 3]).toBe('GETSTATUS');
  }
}

describe('parseTytFirmware', () => {
  it('parses the header, model and region', () => {
    const data = random(5000);
    const fw = parseTytFirmware(buildTyt([{ address: 0x0800c000, data }]));
    expect(fw.radio).toBe('UV3X0');
    expect(fw.firmwareModel).toBe('MD-9600');
    expect(fw.segments).toEqual([{ address: 0x0800c000, data }]);
  });

  it('parses several regions in file order', () => {
    const a = random(100);
    const b = random(3000);
    const fw = parseTytFirmware(
      buildTyt(
        [
          { address: 0x0800c000, data: a },
          { address: 0x08020000, data: b },
        ],
        MD380,
        'JST51',
      ),
    );
    expect(fw.radio).toBe('MD380');
    expect(fw.firmwareModel).toBe('JST51');
    expect(fw.segments).toEqual([
      { address: 0x0800c000, data: a },
      { address: 0x08020000, data: b },
    ]);
  });

  it('knows every counter magic radio_tool knows', () => {
    const radio = (magic: number[]) =>
      parseTytFirmware(buildTyt([{ address: 0x0800c000, data: random(8) }], magic)).radio;
    expect(radio([0x02, 0x19, 0x0c])).toBe('MD2017');
    expect(radio([0x02, 0x18, 0x0c])).toBe('MD2017 GPS');
    expect(radio([0x01, 0x19])).toBe('MD2017');
    expect(radio([0x01, 0x18])).toBe('MD2017 GPS');
    expect(radio([0x01, 0x14])).toBe('MD9600');
    expect(radio([0x02, 0x16, 0x0c])).toBe('UV3X0 GPS');
    expect(radio([0x02, 0x17, 0x0c])).toBe('UV3X0');
    expect(radio([0x01, 0x0f])).toBe('DM1701');
    expect(radio([0x01, 0x10])).toBe('MD390');
    expect(radio([0x01, 0x0d])).toBe('MD380');
    expect(radio([0x01, 0x1b])).toBe('MD280');
  });

  it('reads a 16-character model name without a terminator', () => {
    const file = buildTyt([{ address: 0x0800c000, data: random(8) }], UV3X0, 'ABCDEFGHIJKLMNOP');
    expect(parseTytFirmware(file).firmwareModel).toBe('ABCDEFGHIJKLMNOP');
  });

  it('treats a blank region count as one region', () => {
    const data = random(64);
    const file = buildTyt([{ address: 0x0800c000, data }]);
    new DataView(file.buffer).setUint32(0x7c, 0xffffffff, true);
    expect(parseTytFirmware(file).segments).toEqual([{ address: 0x0800c000, data }]);
  });

  it('rejects malformed files', () => {
    const good = buildTyt([{ address: 0x0800c000, data: random(2048) }]);
    const tamper = (change: (copy: Uint8Array) => void) => {
      const copy = good.slice();
      change(copy);
      return copy;
    };
    expect(() => parseTytFirmware(new Uint8Array(0))).toThrow(FlashError);
    expect(() => parseTytFirmware(good.subarray(0, 0xff))).toThrow(/too short/);
    expect(() => parseTytFirmware(random(4096))).toThrow(/"OutSecurityBin" magic is missing/);
    expect(() => parseTytFirmware(tamper((c) => (c[0] = 0x6f)))).toThrow(/magic is missing/);
    expect(() => parseTytFirmware(tamper((c) => (c[14] = 0x45)))).toThrow(/magic is missing/);
    expect(() => parseTytFirmware(tamper((c) => (c[0x30] = 4)))).toThrow(/counter magic length/);
    expect(() => parseTytFirmware(tamper((c) => (c[0x31] = 0x55)))).toThrow(/not supported/);
    expect(() => parseTytFirmware(tamper((c) => (c[0x7c] = 17)))).toThrow(/region count/);
    expect(() => parseTytFirmware(good.subarray(0, 0x100 + 2047))).toThrow(/truncated/);
    expect(() => parseTytFirmware(tamper((c) => (c[0x84] = 0)).subarray(0, 0x100 + 0x700))).toThrow(
      /truncated/,
    );
    expect(() => parseTytFirmware(buildTyt([]))).toThrow(/holds no firmware/);
    // a raw (unwrapped) firmware image is not accepted either
    expect(() => parseTytFirmware(Uint8Array.from([0x00, 0x00, 0x02, 0x20, ...random(600)]))).toThrow(
      FlashError,
    );
  });
});

describe('flashTyt on a simulated TYT bootloader', () => {
  it('sends exactly what radio_tool sends for a small image', async () => {
    const data = random(0x4000 + 1500); // one 16K sector and a bit of the 64K one
    const { sim, error } = await flashSim(buildTyt([{ address: 0x0800c000, data }]));
    expect(error).toBeNull();
    expect(sim.violations).toEqual([]);

    const writes = (address: number, count: number): TytOp[] =>
      Array.from({ length: count }, (_, i) => ({
        op: 'write',
        block: 2 + i,
        address: address + 1024 * i,
        length: 1024,
      }));
    expect((sim as SimTytRadio).ops).toEqual([
      { op: 'command', code: 0x31 },
      { op: 'erase', address: 0x0800c000 },
      { op: 'erase', address: 0x08010000 },
      { op: 'setAddress', address: 0x0800c000 },
      ...writes(0x0800c000, 16),
      { op: 'setAddress', address: 0x08010000 }, // block numbers restart at 2 in each sector
      { op: 'write', block: 2, address: 0x08010000, length: 1024 },
      { op: 'write', block: 3, address: 0x08010400, length: 476 },
    ]);
    expect(sim.requests.slice(0, 8)).toEqual([
      'GETSTATE',
      'DNLOAD 0 len=2',
      'GETSTATUS',
      'GETSTATUS',
      'GETSTATE',
      'DNLOAD 0 len=5',
      'GETSTATUS',
      'GETSTATUS',
    ]);
    expectRadioToolPattern(sim.requests);
    expect(sim.read(0x0800c000, data.length)).toEqual(data);
    expect(sim.read(0x0800c000 + data.length, 100).every((b) => b === 0xff)).toBe(true);
  });

  it('writes an image spanning four sectors with an odd size', async () => {
    const data = random(0x4000 + 0x10000 + 0x20000 + 12345);
    const regions = [{ address: 0x0800c000, data }];
    const { sim, error, progress, logs, slept } = await flashSim(buildTyt(regions));
    expect(error).toBeNull();
    expect(sim.violations).toEqual([]);
    expect(sim.read(0x0800c000, data.length)).toEqual(data);
    expect((sim as SimTytRadio).ops).toEqual(radioToolOps(regions));
    expectRadioToolPattern(sim.requests);
    expect(sim.read(0x08000000, 0xc000).every((b) => b === 0xff)).toBe(true); // "bootloader" untouched

    const lastOf = (phase: string) => progress.filter((p) => p.phase === phase).at(-1);
    expect(lastOf('erase')).toEqual({ phase: 'erase', done: data.length, total: data.length });
    expect(lastOf('write')).toEqual({ phase: 'write', done: data.length, total: data.length });
    expect(lastOf('verify')).toBeUndefined();
    expect(progress.at(-1)).toEqual({ phase: 'done', done: data.length, total: data.length });
    expect(progress.every((p) => p.done <= p.total)).toBe(true);
    expect(logs.join('\n')).toMatch(/not verified/);
    expect(logs.join('\n')).toMatch(/off and on again/);
    expect(slept()).toBe(0); // like radio_tool, no waiting between the two status reads
    expect(sim.opened).toBe(false);
  });

  it('never reads back, leaves or selects an alternate setting', async () => {
    const { sim } = await flashSim(buildTyt([{ address: 0x0800c000, data: random(3000) }]));
    expect(sim.requests.some((r) => r.startsWith('UPLOAD'))).toBe(false);
    expect(sim.requests).not.toContain('ABORT');
    expect(sim.requests).not.toContain('DNLOAD 0 len=0');
    expect(sim.startedAt).toBeNull();
  });

  it('writes two regions in file order', async () => {
    const regions = [
      { address: 0x08020000, data: random(2000) },
      { address: 0x0800c000, data: random(0x4000) },
    ];
    const { sim, error } = await flashSim(buildTyt(regions));
    expect(error).toBeNull();
    expect((sim as SimTytRadio).ops).toEqual(radioToolOps(regions));
    expect(sim.read(0x08020000, 2000)).toEqual(regions[0].data);
    expect(sim.read(0x0800c000, 0x4000)).toEqual(regions[1].data);
  });

  it("keeps radio_tool's block overrun for a region that does not start on a 1024-byte boundary", async () => {
    // The last block of the first sector is a full 1024 bytes and runs 0x100 into the next
    // sector; the next sector then starts again at its own first byte with the same data.
    const data = random(0x3f00 + 5000);
    const regions = [{ address: 0x0800c100, data }];
    const { sim, error, progress } = await flashSim(buildTyt(regions));
    expect(error).toBeNull();
    expect(sim.violations).toEqual([]);
    const ops = (sim as SimTytRadio).ops;
    expect(ops).toEqual(radioToolOps(regions));
    expect(ops.slice(0, 4)).toEqual([
      { op: 'command', code: 0x31 },
      { op: 'erase', address: 0x0800c100 },
      { op: 'erase', address: 0x08010000 },
      { op: 'setAddress', address: 0x0800c100 },
    ]);
    expect(ops[4 + 15]).toEqual({ op: 'write', block: 17, address: 0x0800fd00, length: 1024 });
    expect(ops[4 + 16]).toEqual({ op: 'setAddress', address: 0x08010000 });
    expect(sim.read(0x0800c100, data.length)).toEqual(data);
    expect(progress.every((p) => p.done <= p.total)).toBe(true);
  });

  it('refuses a region outside the flash before sending anything', async () => {
    const { sim, error } = await flashSim(buildTyt([{ address: 0x080f0000, data: random(0x10001) }]));
    expect((error as Error).message).toMatch(/does not fit the radio: 0x08100000/);
    expect(sim.requests).toEqual([]);
    const ram = await flashSim(buildTyt([{ address: 0x20000000, data: random(16) }]));
    expect(ram.error).toBeInstanceOf(FlashError);
  });

  it('refuses regions that share a sector', async () => {
    const regions = [
      { address: 0x08010000, data: random(100) },
      { address: 0x08018000, data: random(100) },
    ];
    const { sim, error } = await flashSim(buildTyt(regions));
    expect((error as Error).message).toMatch(/share a flash sector/);
    expect(sim.requests).toEqual([]);
  });

  it('rejects a bad file before opening the device', async () => {
    const sim = new SimTytRadio();
    const { error } = await flashSim(random(4096), sim);
    expect((error as Error).message).toMatch(/Not a valid TYT firmware file/);
    expect(sim.opened).toBe(false);
  });

  it('clears a radio left in dfuERROR instead of looping', async () => {
    const sim = new SimTytRadio();
    const dfu = await DfuDevice.open(sim, quietContext());
    await expect(dfu.download(1, Uint8Array.of(0))).rejects.toThrow(FlashError);
    await dfu.close();
    sim.violations.length = 0;
    sim.requests.length = 0;
    const data = random(1024);
    const { error } = await flashSim(buildTyt([{ address: 0x0800c000, data }]), sim);
    expect(error).toBeNull();
    expect(sim.requests.slice(0, 3)).toEqual(['GETSTATE', 'CLRSTATUS', 'GETSTATE']);
    expect(sim.read(0x0800c000, 1024)).toEqual(data);
  });

  describe('refuses anything that is not a TYT bootloader, before sending a thing', () => {
    const firmware = () => buildTyt([{ address: 0x0800c000, data: random(100) }]);
    /** True when the host sent the device no DFU download at all. */
    const sentNothing = (sim: SimStm32Dfu) => !sim.requests.some((r) => /DNLOAD/i.test(r));

    it('a TYT radio in normal mode', async () => {
      const radio = new SimTytRadio({ alternateNames: TYT_ORIGINAL_NAMES });
      const { error } = await flashSim(firmware(), radio);
      expect(error).toBeInstanceOf(FlashError);
      expect((error as Error).message).toMatch(/not in flashing mode/);
      expect(radio.ops).toEqual([]);
      expect(sentNothing(radio)).toBe(true);
      expect(radio.flash.every((b) => b === 0xff)).toBe(true);
    });

    it('a bare STM32 in its ROM bootloader', async () => {
      const rom = new SimStm32Dfu({ strictPoll: false });
      const { error } = await flashSim(firmware(), rom);
      expect((error as Error).message).toMatch(/not in flashing mode/);
      expect(sentNothing(rom)).toBe(true);
      expect(rom.flash.every((b) => b === 0xff)).toBe(true);
    });

    it('a device that reports no flash layout', async () => {
      const radio = new SimTytRadio({ alternateNames: [null] });
      const { error } = await flashSim(firmware(), radio);
      expect((error as Error).message).toMatch(/Could not tell whether the radio is in flashing mode/);
      expect(radio.ops).toEqual([]);
      expect(sentNothing(radio)).toBe(true);
    });
  });
});

describe('the simulated TYT bootloader is strict', () => {
  /** Opens a DfuDevice on a fresh simulated radio. */
  async function open() {
    const sim = new SimTytRadio();
    const dfu = await DfuDevice.open(sim, quietContext());
    return { sim, dfu };
  }

  it('rejects erase and data before the 91 31 command', async () => {
    const { sim, dfu } = await open();
    await expect(dfu.eraseSector(0x0800c000)).rejects.toThrow(/errVENDOR/);
    await dfu.setAddress(0x0800c000);
    await expect(dfu.writeBlock(2, random(1024), 'write')).rejects.toThrow(/errVENDOR/);
    expect(sim.violations).toEqual([
      'erase before the 91 31 firmware upgrade command',
      'write before the 91 31 firmware upgrade command',
    ]);
    expect(sim.flash.every((b) => b === 0xff)).toBe(true);
  });

  it('requires an erase before a write, even to blank flash', async () => {
    const { sim, dfu } = await open();
    await dfu.download(0, Uint8Array.of(0x91, 0x31));
    await dfu.waitDownloadIdle('upgrade');
    expect(sim.upgradeMode).toBe(true);
    await dfu.setAddress(0x0800c000);
    await expect(dfu.writeBlock(2, random(1024), 'write')).rejects.toThrow(/errVENDOR/);
    expect(sim.violations).toEqual(['write to sector 0x800c000 before erasing it']);

    await dfu.eraseSector(0x0800c000);
    await dfu.setAddress(0x0800c000);
    const block = random(1024);
    await dfu.writeBlock(2, block, 'write');
    expect(sim.read(0x0800c000, 1024)).toEqual(block);
    // a block that runs into the next, unerased sector is refused whole
    await dfu.setAddress(0x0800fe00);
    await expect(dfu.writeBlock(2, random(1024), 'write')).rejects.toThrow(/errVENDOR/);
  });

  it('protects the bootloader sectors', async () => {
    const { dfu } = await open();
    await dfu.download(0, Uint8Array.of(0x91, 0x31));
    await dfu.waitDownloadIdle('upgrade');
    await expect(dfu.eraseSector(0x08000000)).rejects.toThrow(/errTARGET/);
    await expect(dfu.eraseSector(0x08008000)).rejects.toThrow(/errTARGET/);
  });

  it('has no read-back, no leave and 1024-byte blocks', async () => {
    const { sim, dfu } = await open();
    expect(dfu.functional?.transferSize).toBe(1024);
    await expect(dfu.upload(2, 1024)).rejects.toThrow(/refused DFU UPLOAD/);
    await dfu.abortToIdle();
    await expect(dfu.download(2, new Uint8Array(1025))).rejects.toThrow(/refused DFU DNLOAD/);
    await dfu.abortToIdle();
    await dfu.setAddress(0x0800c000);
    await expect(dfu.download(0, new Uint8Array(0))).rejects.toThrow(/refused DFU DNLOAD/);
    await dfu.abortToIdle();
    await expect(dfu.download(0, Uint8Array.of(0x91, 0x05))).resolves.toBeUndefined();
    await expect(dfu.waitDownloadIdle('reboot')).rejects.toThrow(/errTARGET/);
    expect(sim.ops.at(-1)).toEqual({ op: 'command', code: 0x05 });
  });
});

describe.skipIf(!RELEASE_DIR)('OpenRTX v0.4.5 release files on the simulated TYT bootloader', () => {
  // Segment lengths cross-checked with `radio_tool --fw-info -i <file>`.
  const files = [
    { name: 'openrtx_md3x0_v0.4.5.bin', radio: 'MD380', model: 'JST51', length: 0x38d70 },
    { name: 'openrtx_mduv3x0_v0.4.5.bin', radio: 'UV3X0', model: 'MD-9600', length: 0x39c38 },
    { name: 'openrtx_dm1701_v0.4.5.bin', radio: 'DM1701', model: 'DM1701', length: 0x37e38 },
  ];

  it.each(files)('parses and flashes $name', async ({ name, radio, model, length }) => {
    const wrapped = new Uint8Array(readFileSync(join(RELEASE_DIR ?? '', name)));
    const fw = parseTytFirmware(wrapped);
    expect(fw.radio).toBe(radio);
    expect(fw.firmwareModel).toBe(model);
    expect(fw.segments.map((s) => [s.address, s.data.length])).toEqual([[0x0800c000, length]]);
    expect(fw.segments[0].data).toEqual(wrapped.subarray(0x100, 0x100 + length)); // sent as stored
    expect(wrapped.length).toBe(0x100 + length + 0x100);

    const { sim, error, progress } = await flashSim(wrapped);
    expect(error).toBeNull();
    expect(sim.violations).toEqual([]);
    expect(sim.read(0x0800c000, length)).toEqual(fw.segments[0].data);
    expect((sim as SimTytRadio).ops).toEqual(radioToolOps(fw.segments));
    expectRadioToolPattern(sim.requests);
    expect(sim.requests.filter((r) => r === 'DNLOAD 0 len=5')).toHaveLength(8); // 4 erases, 4 set-address
    expect(progress.at(-1)).toEqual({ phase: 'done', done: length, total: length });
  });

  it('refuses the files that are not TYT-wrapped', () => {
    for (const name of ['openrtx_mod17_v0.4.5.bin', 'openrtx_cs7000_v0.4.5.dfu', 'openrtx_gd77_v0.4.5.sgl']) {
      expect(() => parseTytFirmware(new Uint8Array(readFileSync(join(RELEASE_DIR ?? '', name))))).toThrow(
        FlashError,
      );
    }
  });
});
