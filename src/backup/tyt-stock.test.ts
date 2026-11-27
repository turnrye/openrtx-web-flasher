// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { DfuDevice, DfuState, type DfuStatus } from '../flash/dfu.ts';
import { FlashError, quietContext, type Progress } from '../flash/types.ts';
import { SimTytStock, type SimTytStockOptions } from '../sim/tyt-stock.ts';
import {
  parseTytVersion,
  readTytStock,
  tytStockDeviceKind,
  TYT_STOCK_PLANS,
  TytStockGuard,
  TytStockRefused,
  type TytStockModel,
  type TytStockTransport,
} from './tyt-stock.ts';
import type { BackupPart, RadioBackup } from './types.ts';

const MODELS = Object.keys(TYT_STOCK_PLANS) as TytStockModel[];
const INFO_FILES = ['02', '01', '03', '04', '05', '07', '08', '32', '33', '50'].map((c) => `info-${c}.bin`);
/** A smaller SPI flash where the test is not about its size. */
const SMALL: SimTytStockOptions = { spiSize: 0x200000 };

/** Bytes as hex without separators. */
function hex(data: Uint8Array): string {
  return [...data].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The part with this file name; fails the test when it is missing. */
function part(backup: RadioBackup, file: string): BackupPart {
  const found = backup.parts.find((p) => p.file === file);
  if (!found) throw new Error(`no part ${file} in ${backup.parts.map((p) => p.file).join(', ')}`);
  return found;
}

/** True when two byte arrays are equal; cheaper than a deep comparison of 16 MB. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.length).equals(b);
}

/** Checks the info blocks and the snapshot of a backup against the simulator's memory. */
function expectInfoAndSnapshot(backup: RadioBackup, sim: SimTytStock): void {
  for (const file of INFO_FILES) {
    const p = part(backup, file);
    expect(p.kind).toBe('info');
    expect(p.complete).toBe(true);
    expect(hex(p.data)).toBe(hex(sim.infoBlock(parseInt(file.slice(5, 7), 16))));
  }
  const snapshot = part(backup, 'bootloader-65535.bin');
  expect(snapshot.kind).toBe('internal-flash');
  expect(snapshot.address).toBe(0x08000000);
  expect(snapshot.complete).toBe(true);
  expect(sameBytes(snapshot.data, sim.flash.subarray(0, 65535))).toBe(true);
}

/** A transport that records what the guard lets through and answers dfuIDLE. */
function recorder(): TytStockTransport & { sent: string[] } {
  const sent: string[] = [];
  const idle: DfuStatus = { status: 0, pollTimeout: 0, state: DfuState.dfuIDLE };
  return {
    sent,
    download: async (blockNum, data) => void sent.push(`DNLOAD ${blockNum} [${hex(data)}]`),
    upload: async (blockNum, length) => {
      sent.push(`UPLOAD ${blockNum} ${length}`);
      return new Uint8Array(length);
    },
    getStatus: async () => {
      sent.push('GETSTATUS');
      return idle;
    },
    clearStatus: async () => void sent.push('CLRSTATUS'),
    abort: async () => void sent.push('ABORT'),
  };
}

describe('the plans', () => {
  it('only the MD-9600 plan is marked as measured on a radio', () => {
    expect(MODELS.filter((m) => TYT_STOCK_PLANS[m].checked)).toEqual(['md9600']);
  });

  it('every range is whole 1024-byte blocks inside the SPI flash', () => {
    for (const model of MODELS) {
      const plan = TYT_STOCK_PLANS[model];
      expect(plan.snapshot).toBeLessThanOrEqual(65535);
      expect(plan.spiSize % 1024).toBe(0);
      for (const r of plan.quick) {
        expect(r.address % 1024).toBe(0);
        expect(r.length % 1024).toBe(0);
        expect(r.address + r.length).toBeLessThanOrEqual(plan.spiSize);
      }
    }
  });

  it('the quick ranges cover the codeplug areas dmrconfig and qdmr read', () => {
    const covers = (model: TytStockModel, from: number, to: number) =>
      TYT_STOCK_PLANS[model].quick.some((r) => r.address <= from && r.address + r.length >= to);
    for (const model of MODELS) expect(covers(model, 0x2000, 0x40000)).toBe(true);
    for (const model of ['mduv3x0', 'dm1701', 'md9600'] as const) {
      expect(covers(model, 0x110000, 0x1a0000)).toBe(true);
    }
  });
});

describe('the allowlist', () => {
  const v = (...bytes: number[]) => Uint8Array.from(bytes);
  const refusedDownloads: [string, number, Uint8Array][] = [
    ['erase', 0, v(0x41, 0x00, 0xc0, 0x00, 0x08)],
    ['write', 2, new Uint8Array(1024)],
    ['write of a command', 2, v(0xa2, 0x02)],
    ['block 1', 1, v(0xa2, 0x02)],
    ['zero-length DNLOAD (manifest)', 0, v()],
    ['91 02', 0, v(0x91, 0x02)],
    ['91 03', 0, v(0x91, 0x03)],
    ['91 04', 0, v(0x91, 0x04)],
    ['91 31 (firmware upgrade)', 0, v(0x91, 0x31)],
    ['91 32', 0, v(0x91, 0x32)],
    ['91 50', 0, v(0x91, 0x50)],
    ['91 alone', 0, v(0x91)],
    ['91 01 with a tail', 0, v(0x91, 0x01, 0x00)],
    ['B2', 0, v(0xb2, ...new Array<number>(32).fill(0))],
    ['B3', 0, v(0xb3, 0)],
    ['B4', 0, v(0xb4, 1)],
    ['B5', 0, v(0xb5, 0, 0, 0, 0, 0, 0, 0)],
    ['C4', 0, v(0xc4, 0, 0, 0, 0, 0, 0, 0, 0, 0)],
    ['D5', 0, v(0xd5, 0)],
    ['A2 without a code', 0, v(0xa2)],
    ['A2 with two codes', 0, v(0xa2, 1, 2)],
    ['short set address', 0, v(0x21, 0, 0, 0)],
    ['long set address', 0, v(0x21, 0, 0, 0, 0, 0)],
  ];

  for (const original of [true, false]) {
    const device = original ? 'the original firmware' : 'a bootloader';

    it(`refuses every forbidden request to ${device} before it is sent`, async () => {
      const t = recorder();
      const g = new TytStockGuard(t, original);
      for (const [name, blockNum, data] of refusedDownloads) {
        await expect(g.download(blockNum, data), name).rejects.toBeInstanceOf(TytStockRefused);
      }
      await expect(g.upload(1, 1024)).rejects.toBeInstanceOf(TytStockRefused);
      await expect(g.upload(0, 1025)).rejects.toBeInstanceOf(TytStockRefused);
      await expect(g.upload(3, 2048)).rejects.toBeInstanceOf(TytStockRefused);
      await expect(g.upload(2, 65536)).rejects.toBeInstanceOf(TytStockRefused);
      await expect(g.upload(2, 0)).rejects.toBeInstanceOf(TytStockRefused);
      await expect(g.upload(2.5, 1024)).rejects.toBeInstanceOf(TytStockRefused);
      await expect(g.upload(-1, 1024)).rejects.toBeInstanceOf(TytStockRefused);
      await expect(g.upload(0x10000, 1024)).rejects.toBeInstanceOf(TytStockRefused);
      expect(t.sent).toEqual([]);
    });

    it(`passes the backup's requests to ${device}; the snapshot only before program mode`, async () => {
      const t = recorder();
      const g = new TytStockGuard(t, original);
      await g.getStatus();
      await g.upload(2, 65535);
      expect(g.programMode).toBe(false);
      await g.download(0, v(0x91, 0x01));
      expect(g.programMode).toBe(true);
      await expect(g.upload(2, 2048)).rejects.toBeInstanceOf(TytStockRefused);
      await expect(g.upload(2, 65535)).rejects.toBeInstanceOf(TytStockRefused);
      await g.upload(3, 1024);
      await g.download(0, v(0xa2, 0x07));
      await g.upload(0, 1024);
      await g.download(0, v(0x21, 0, 0, 0, 0));
      await g.abort();
      await g.clearStatus();
      expect(t.sent).toEqual([
        'GETSTATUS',
        'UPLOAD 2 65535',
        'DNLOAD 0 [9101]',
        'UPLOAD 3 1024',
        'DNLOAD 0 [a207]',
        'UPLOAD 0 1024',
        'DNLOAD 0 [2100000000]',
        'ABORT',
        'CLRSTATUS',
      ]);
    });
  }

  it('sends 91 05 to the original firmware and never to a bootloader', async () => {
    const t = recorder();
    await new TytStockGuard(t, true).download(0, v(0x91, 0x05));
    expect(t.sent).toEqual(['DNLOAD 0 [9105]']);
    await expect(new TytStockGuard(t, false).download(0, v(0x91, 0x05))).rejects.toBeInstanceOf(
      TytStockRefused,
    );
    expect(t.sent).toHaveLength(1);
  });

  it('a refusal is a FlashError that names the request', async () => {
    const refusal = new TytStockGuard(recorder(), true).download(0, v(0x91, 0x31));
    await expect(refusal).rejects.toBeInstanceOf(FlashError);
    await expect(refusal).rejects.toThrow(/DNLOAD block 0, 2 bytes \[91 31\]/);
  });
});

describe('telling the devices apart', () => {
  it('knows the original firmware and the bootloader by alt 0, spaces not counted', () => {
    expect(tytStockDeviceKind('@Internal Flash   /0x08000000/03*016Kg')).toBe('original');
    expect(tytStockDeviceKind('@Internal Flash /0x08000000/03*016Kg')).toBe('original');
    expect(tytStockDeviceKind('@Internal Flash   /0x0800C000/01*016Kg,01*064Kg,07*128Kg')).toBe('bootloader');
  });

  it('knows nothing else', () => {
    expect(tytStockDeviceKind('@Internal Flash  /0x08000000/03*016Kg,01*016Kg')).toBeNull();
    expect(tytStockDeviceKind('@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg')).toBeNull();
    expect(tytStockDeviceKind('@SPI Flash Memory /0x00000000/16*064Kg')).toBeNull();
    expect(tytStockDeviceKind('')).toBeNull();
    expect(tytStockDeviceKind(null)).toBeNull();
  });
});

describe('the version', () => {
  it('reads the variant letter and six decimal digits', () => {
    expect(parseTytVersion(Uint8Array.of(0x56, 0x00, 0x60, 0x09))).toBe('V006.009');
    expect(parseTytVersion(Uint8Array.of(0x44, 0x01, 0x30, 0x20))).toBe('D013.020');
    expect(parseTytVersion(Uint8Array.of(0x50, 0x12, 0x34, 0x56))).toBe('P123.456');
  });

  it("is null for the bootloader's answer and for anything odd", () => {
    expect(parseTytVersion(Uint8Array.of(0x54, 0x02, 0x10, 0x06))).toBeNull();
    expect(parseTytVersion(Uint8Array.of(0x00, 0x21, 0x41))).toBeNull();
    expect(parseTytVersion(Uint8Array.of(0x56, 0x0a, 0x60, 0x09))).toBeNull();
    expect(parseTytVersion(Uint8Array.of(0x31, 0x00, 0x60, 0x09))).toBeNull();
    expect(parseTytVersion(new Uint8Array(1024))).toBeNull();
    expect(parseTytVersion(undefined)).toBeNull();
  });
});

describe('a backup from the original firmware', () => {
  for (const model of MODELS) {
    it(`${model}: everything, byte for byte, then the restart`, async () => {
      const sim = new SimTytStock();
      const backup = await readTytStock(sim, model, 'all', quietContext());
      expect(sim.forbidden).toEqual([]);
      expectInfoAndSnapshot(backup, sim);
      const spi = part(backup, 'spi-flash.bin');
      expect(spi.kind).toBe('spi-flash');
      expect(spi.address).toBe(0);
      expect(spi.complete).toBe(true);
      expect(sameBytes(spi.data, sim.spi)).toBe(true);
      expect(backup.parts).toHaveLength(INFO_FILES.length + 2);
      expect(backup.radioId).toBe(hex(sim.uid));
      expect(backup.idKind).toBe('uid');
      expect(backup.firmware).toBe('V006.009');
      expect(sim.restarts).toBe(1);
      expect(sim.commands.at(-1)).toBe('91 05');
      expect(sim.opened).toBe(false);
    });

    it(`${model}: the codeplug areas only`, async () => {
      const sim = new SimTytStock();
      const backup = await readTytStock(sim, model, 'quick', quietContext());
      expect(sim.forbidden).toEqual([]);
      expectInfoAndSnapshot(backup, sim);
      const ranges = TYT_STOCK_PLANS[model].quick;
      expect(backup.parts).toHaveLength(INFO_FILES.length + 1 + ranges.length);
      for (const r of ranges) {
        const spi = part(backup, `spi-flash-${r.address.toString(16).padStart(6, '0')}.bin`);
        expect(spi.kind).toBe('spi-flash');
        expect(spi.address).toBe(r.address);
        expect(spi.complete).toBe(true);
        expect(sameBytes(spi.data, sim.spi.subarray(r.address, r.address + r.length))).toBe(true);
      }
      expect(sim.restarts).toBe(1);
    });
  }

  it('says so when the plan was not measured on a radio of that model', async () => {
    const unchecked = await readTytStock(new SimTytStock(SMALL), 'md3x0', 'quick', quietContext());
    expect(unchecked.notes.join('\n')).toMatch(/not been checked on a radio/);
    const checked = await readTytStock(new SimTytStock(SMALL), 'md9600', 'quick', quietContext());
    expect(checked.notes).toEqual([]);
  });

  it('sends the measured sequence: info, snapshot, program mode, address 0, SPI, restart', async () => {
    const sim = new SimTytStock(SMALL);
    await readTytStock(sim, 'md3x0', 'quick', quietContext());
    expect(sim.commands).toEqual([
      'a2 02',
      'a2 01',
      'a2 03',
      'a2 04',
      'a2 05',
      'a2 07',
      'a2 08',
      'a2 32',
      'a2 33',
      'a2 50',
      '91 01',
      '21 00 00 00 00',
      '91 05',
    ]);
    // The first info block, whole: idle check, command, two status reads, abort, upload.
    expect(sim.requests.slice(0, 7)).toEqual([
      'GETSTATUS',
      'DNLOAD 0 len=2',
      'GETSTATUS',
      'GETSTATUS',
      'ABORT',
      'UPLOAD 0 len=1024',
      'DNLOAD 0 len=2',
    ]);
    // One snapshot, before program mode; then 1024-byte blocks from block 2.
    const snapshot = sim.requests.indexOf('UPLOAD 2 len=65535');
    expect(sim.requests.filter((r) => r.startsWith('UPLOAD 2 len='))).toHaveLength(2);
    expect(sim.requests.slice(snapshot, snapshot + 3)).toEqual([
      'UPLOAD 2 len=65535',
      'ABORT',
      'DNLOAD 0 len=2',
    ]);
    expect(sim.requests.filter((r) => /^UPLOAD (?!0 )\d+ len=1024$/.test(r))).toHaveLength(0x40000 / 1024);
    expect(sim.requests.at(-4)).toBe('UPLOAD 257 len=1024');
    expect(sim.requests.slice(-3)).toEqual(['ABORT', 'DNLOAD 0 len=2', 'GETSTATUS']);
    expect(sim.requests.some((r) => r === 'GETSTATE' || r === 'DETACH')).toBe(false);
  });

  it('reaches the second codeplug area by block number, with the address left at 0', async () => {
    const sim = new SimTytStock(SMALL);
    await readTytStock(sim, 'mduv3x0', 'quick', quietContext());
    const blocks = sim.requests.filter((r) => /^UPLOAD \d+ len=1024$/.test(r) && !r.startsWith('UPLOAD 0 '));
    expect(blocks[0]).toBe('UPLOAD 2 len=1024');
    expect(blocks[255]).toBe('UPLOAD 257 len=1024');
    expect(blocks[256]).toBe(`UPLOAD ${2 + 0x110000 / 1024} len=1024`);
    expect(blocks.at(-1)).toBe(`UPLOAD ${2 + 0x1a0000 / 1024 - 1} len=1024`);
    expect(sim.commands.filter((c) => c.startsWith('21'))).toEqual(['21 00 00 00 00']);
  });

  it('reports progress in bytes, never backwards, ending at the total', async () => {
    const seen: Progress[] = [];
    const sim = new SimTytStock(SMALL);
    await readTytStock(sim, 'mduv3x0', 'quick', quietContext({ progress: (p) => seen.push({ ...p }) }));
    const total = 10 * 1024 + 65535 + 0x40000 + 0x90000;
    expect(seen.every((p) => p.total === total)).toBe(true);
    expect(seen[0]).toEqual({ phase: 'connect', done: 0, total });
    expect(seen.at(-1)).toEqual({ phase: 'done', done: total, total });
    expect(seen.at(-2)).toEqual({ phase: 'read', done: total, total });
    expect(seen.slice(1, -1).every((p) => p.phase === 'read')).toBe(true);
    expect(seen.every((p, i) => i === 0 || p.done >= seen[i - 1].done)).toBe(true);
  });

  it('logs the version, the SPI read and the restart, and never sleeps', async () => {
    const lines: string[] = [];
    const sleeps: number[] = [];
    const ctx = quietContext({
      log: (m) => lines.push(m),
      sleep: async (ms) => void sleeps.push(ms),
    });
    await readTytStock(new SimTytStock(SMALL), 'md9600', 'quick', ctx);
    const log = lines.join('\n');
    expect(log).toMatch(/Original firmware version V006\.009\./);
    expect(log).toMatch(/Reading 2 MB of SPI flash, up to about 1 min\./);
    expect(log).toMatch(/restart command \(91 05\)/);
    expect(sleeps).toEqual([]);
  });

  it('reads the interface name from the descriptors when the browser gives none', async () => {
    const sim = new SimTytStock({ ...SMALL, exposeInterfaceNames: false });
    const backup = await readTytStock(sim, 'md3x0', 'quick', quietContext());
    expect(backup.parts).toHaveLength(INFO_FILES.length + 2);
    expect(sim.forbidden).toEqual([]);
  });
});

describe('the radio ID', () => {
  it('is null when the UID is blank', async () => {
    const sim = new SimTytStock({ ...SMALL, uid: null });
    const backup = await readTytStock(sim, 'md3x0', 'quick', quietContext());
    expect(backup.radioId).toBeNull();
    expect(backup.idKind).toBeNull();
    expect(part(backup, 'info-07.bin').data).toHaveLength(16);
  });

  it('is null when the radio does not answer block 07, and the rest is still read', async () => {
    const sim = new SimTytStock(SMALL);
    sim.stallInfo = [0x07];
    const backup = await readTytStock(sim, 'md3x0', 'quick', quietContext());
    expect(sim.forbidden).toEqual([]);
    expect(backup.radioId).toBeNull();
    expect(backup.idKind).toBeNull();
    // The block is listed all the same, as a part that was not read.
    const block = part(backup, 'info-07.bin');
    expect(block.complete).toBe(false);
    expect(block.data).toHaveLength(0);
    expect(block.note).toMatch(/could not be read: The device refused DFU DNLOAD/);
    expect(backup.parts).toHaveLength(INFO_FILES.length + 2);
    expect(backup.parts.filter((p) => !p.complete).map((p) => p.file)).toEqual(['info-07.bin']);
    expect(backup.notes).toContain('The radio did not give info block 07.');
    expect(sameBytes(part(backup, 'info-08.bin').data, sim.infoBlock(0x08))).toBe(true);
    expect(part(backup, 'spi-flash-000000.bin').complete).toBe(true);
  });

  it('has no firmware version when the answer is not one', async () => {
    const sim = new SimTytStock({ ...SMALL, version: Uint8Array.of(0xff, 0xff, 0xff, 0xff) });
    const backup = await readTytStock(sim, 'md3x0', 'quick', quietContext());
    expect(backup.firmware).toBeUndefined();
    expect(part(backup, 'info-02.bin').data).toHaveLength(4);
  });
});

describe('a host that caps a control transfer at 4096 bytes (Linux)', () => {
  it('gives a shorter snapshot, marked incomplete with a note', async () => {
    const lines: string[] = [];
    const sim = new SimTytStock({ ...SMALL, usbCap: 4096 });
    const backup = await readTytStock(sim, 'md9600', 'quick', quietContext({ log: (m) => lines.push(m) }));
    expect(sim.forbidden).toEqual([]);
    const snapshot = part(backup, 'bootloader-4096.bin');
    expect(snapshot.complete).toBe(false);
    expect(snapshot.address).toBe(0x08000000);
    expect(snapshot.note).toMatch(/Only the first 4096 of 65535 bytes/);
    expect(sameBytes(snapshot.data, sim.flash.subarray(0, 4096))).toBe(true);
    expect(backup.notes.some((n) => n.includes('Only the first 4096 of 65535 bytes'))).toBe(true);
    expect(lines.some((l) => l.includes('read of 65535 bytes of internal flash did not pass'))).toBe(true);
    // The larger sizes never reached the radio; the rest of the backup is whole.
    expect(sim.requests.filter((r) => r.startsWith('UPLOAD 2 len=')).slice(0, 1)).toEqual([
      'UPLOAD 2 len=4096',
    ]);
    const spi = part(backup, 'spi-flash-000000.bin');
    expect(spi.complete).toBe(true);
    expect(sameBytes(spi.data, sim.spi)).toBe(true);
    expect(sim.restarts).toBe(1);
  });
});

describe('a read that stops part-way', () => {
  it('keeps what was read when the radio refuses a block, and still restarts it', async () => {
    const sim = new SimTytStock();
    sim.stallSpiAt = 0x123456;
    const backup = await readTytStock(sim, 'md9600', 'all', quietContext());
    expect(sim.forbidden).toEqual([]);
    const spi = part(backup, 'spi-flash.bin');
    expect(spi.complete).toBe(false);
    expect(spi.data).toHaveLength(0x123400);
    expect(sameBytes(spi.data, sim.spi.subarray(0, 0x123400))).toBe(true);
    expect(spi.note).toMatch(/stopped after 1192960 of 16777216 bytes/);
    expect(
      backup.notes.some((n) => n.includes('SPI flash read stopped early, with 1192960 of 16777216')),
    ).toBe(true);
    expectInfoAndSnapshot(backup, sim);
    expect(sim.commands.at(-1)).toBe('91 05');
    expect(sim.restarts).toBe(1);
  });

  it('keeps a block the radio cut short, and stops there', async () => {
    const sim = new SimTytStock(SMALL);
    sim.shortSpiAt = 0x1000 + 100;
    const backup = await readTytStock(sim, 'mduv3x0', 'quick', quietContext());
    expect(sim.forbidden).toEqual([]);
    const spi = part(backup, 'spi-flash-000000.bin');
    expect(spi.complete).toBe(false);
    expect(sameBytes(spi.data, sim.spi.subarray(0, 0x1000 + 100))).toBe(true);
    expect(spi.note).toMatch(/the radio sent 100 bytes of a 1024-byte block/);
    // The second area was not tried after the first one failed; it is listed as not read.
    const second = part(backup, 'spi-flash-110000.bin');
    expect(second.complete).toBe(false);
    expect(second.data).toHaveLength(0);
    expect(second.note).toMatch(/stopped after 0 of 589824 bytes/);
    expect(sim.requests.some((r) => r.startsWith(`UPLOAD ${2 + 0x110000 / 1024} `))).toBe(false);
    expect(sim.restarts).toBe(1);
  });

  it('keeps the first area when the second one fails', async () => {
    const sim = new SimTytStock(SMALL);
    sim.stallSpiAt = 0x110000;
    const backup = await readTytStock(sim, 'dm1701', 'quick', quietContext());
    expect(part(backup, 'spi-flash-000000.bin').complete).toBe(true);
    const second = part(backup, 'spi-flash-110000.bin');
    expect(second.complete).toBe(false);
    expect(second.address).toBe(0x110000);
    expect(second.data).toHaveLength(0);
    expect(second.note).toMatch(/stopped after 0 of 589824 bytes: The device refused DFU UPLOAD/);
    expect(backup.notes.some((n) => n.includes('stopped early, with 262144 of 851968 bytes'))).toBe(true);
    expect(sim.restarts).toBe(1);
  });

  it('lists the SPI flash as an incomplete part when not one block of it was read', async () => {
    const sim = new SimTytStock(SMALL);
    sim.stallSpiAt = 0;
    const backup = await readTytStock(sim, 'mduv3x0', 'all', quietContext());
    expect(sim.forbidden).toEqual([]);
    const spi = part(backup, 'spi-flash.bin');
    expect(spi.kind).toBe('spi-flash');
    expect(spi.address).toBe(0);
    expect(spi.complete).toBe(false);
    expect(spi.data).toHaveLength(0);
    expect(spi.note).toMatch(/stopped after 0 of 16777216 bytes: The device refused DFU UPLOAD/);
    // Every planned part is there, so a backup without its memory chip never looks whole.
    expect(backup.parts).toHaveLength(INFO_FILES.length + 2);
    expect(backup.parts.every((p) => p.complete)).toBe(false);
    expectInfoAndSnapshot(backup, sim);
    expect(sim.restarts).toBe(1);
  });

  it('lists the SPI flash as an incomplete part when the radio does not enter program mode', async () => {
    const sim = new SimTytStock(SMALL);
    sim.refuseProgramMode = true;
    const backup = await readTytStock(sim, 'dm1701', 'quick', quietContext());
    expect(sim.forbidden).toEqual([]);
    for (const file of ['spi-flash-000000.bin', 'spi-flash-110000.bin']) {
      const spi = part(backup, file);
      expect(spi.complete).toBe(false);
      expect(spi.data).toHaveLength(0);
      expect(spi.note).toMatch(/stopped after 0 of \d+ bytes: The device refused DFU DNLOAD/);
    }
    expectInfoAndSnapshot(backup, sim);
  });

  it('lists the bootloader snapshot as an incomplete part when no read size passes', async () => {
    const sim = new SimTytStock({ ...SMALL, usbCap: 1024 });
    const backup = await readTytStock(sim, 'md9600', 'quick', quietContext());
    expect(sim.forbidden).toEqual([]);
    const snapshot = part(backup, 'bootloader-0.bin');
    expect(snapshot.kind).toBe('internal-flash');
    expect(snapshot.address).toBe(0x08000000);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.data).toHaveLength(0);
    expect(snapshot.note).toMatch(/could not be read/);
    expect(backup.notes).toContain('The start of the internal flash (the bootloader) could not be read.');
    expect(part(backup, 'spi-flash-000000.bin').complete).toBe(true);
  });

  it('throws when nothing at all could be read, after restarting the radio', async () => {
    const sim = new SimTytStock({ ...SMALL, usbCap: 1024 });
    sim.stallInfo = [...TYT_STOCK_PLANS.md9600.info];
    sim.stallSpiAt = 0;
    await expect(readTytStock(sim, 'md9600', 'quick', quietContext())).rejects.toThrow(
      /Nothing could be read from the radio/,
    );
    expect(sim.forbidden).toEqual([]);
    expect(sim.commands.at(-1)).toBe('91 05');
    expect(sim.restarts).toBe(1);
    expect(sim.opened).toBe(false);
  });
});

describe('a radio that is not running its original firmware', () => {
  it('refuses the bootloader, asks for the radio in normal mode, sends nothing', async () => {
    const sim = new SimTytStock({ ...SMALL, mode: 'bootloader' });
    const attempt = readTytStock(sim, 'md9600', 'all', quietContext());
    await expect(attempt).rejects.toBeInstanceOf(FlashError);
    await expect(attempt).rejects.toThrow(/flashing mode.*normal mode.*Nothing was sent/);
    expect(sim.requests).toEqual([]);
    expect(sim.commands).toEqual([]);
    expect(sim.forbidden).toEqual([]);
    expect(sim.programMode).toBe(false);
    expect(sim.opened).toBe(false);
  });

  it('refuses an unknown interface string and sends nothing', async () => {
    const names = [
      ['@Internal Flash  /0x08000000/03*016Kg,01*016Kg,01*064Kg,07*128Kg', null],
      ['@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg', '@Option Bytes  /0x1FFFC000/01*016 e'],
      ['@SPI Flash Memory /0x00000000/16*064Kg', '@Internal Flash   /0x08000000/03*016Kg'],
      [null, null],
    ];
    for (const alternateNames of names) {
      const sim = new SimTytStock({ ...SMALL, alternateNames });
      await expect(
        readTytStock(sim, 'md9600', 'all', quietContext()),
        String(alternateNames),
      ).rejects.toThrow(/not a radio running its original firmware, so nothing was sent/);
      expect(sim.requests).toEqual([]);
      expect(sim.forbidden).toEqual([]);
    }
  });
});

describe('the simulator', () => {
  /** Opens the simulator and runs one block 0 command the way the reader does. */
  async function open(sim: SimTytStock): Promise<DfuDevice> {
    return DfuDevice.open(sim, quietContext());
  }

  /** DNLOAD, two status reads, ABORT; returns the two states. */
  async function command(dfu: DfuDevice, ...bytes: number[]): Promise<number[]> {
    await dfu.download(0, Uint8Array.from(bytes));
    const states = [(await dfu.getStatus()).state, (await dfu.getStatus()).state];
    await dfu.abort();
    return states;
  }

  it('lists every request outside the allowlist that reaches it, and stalls it', async () => {
    const sim = new SimTytStock(SMALL);
    const dfu = await open(sim);
    const before = hex(sim.spi.subarray(0, 4096)) + hex(sim.flash.subarray(0, 4096));
    await expect(dfu.download(0, Uint8Array.of(0x91, 0x31))).rejects.toThrow(/stall/);
    await dfu.clearStatus();
    await expect(dfu.eraseSector(0x0800c000)).rejects.toThrow(/stall/);
    await dfu.clearStatus();
    await expect(dfu.download(2, new Uint8Array(1024))).rejects.toThrow(/stall/);
    await dfu.clearStatus();
    await expect(dfu.download(0, new Uint8Array(0))).rejects.toThrow(/stall/);
    await dfu.clearStatus();
    await expect(dfu.upload(1, 1024)).rejects.toThrow(/stall/);
    await dfu.clearStatus();
    await expect(dfu.getState()).rejects.toThrow(/stall/);
    await dfu.clearStatus();
    expect(await command(dfu, 0x91, 0x01)).toEqual([DfuState.dfuDNBUSY, DfuState.dfuDNLOAD_IDLE]);
    await expect(dfu.upload(2, 4096)).rejects.toThrow(/stall/);
    expect(sim.forbidden).toEqual([
      'DNLOAD block 0 [91 31]',
      'DNLOAD block 0 [41 00 c0 00 08]',
      'DNLOAD block 2, 1024 bytes',
      'zero-length DNLOAD',
      'UPLOAD block 1, 1024 bytes',
      'IN request 5',
      'UPLOAD block 2, 4096 bytes',
    ]);
    expect(hex(sim.spi.subarray(0, 4096)) + hex(sim.flash.subarray(0, 4096))).toBe(before);
    expect(sim.restarts).toBe(0);
  });

  it('original firmware: the snapshot ignores the block number; 91 05 needs program mode', async () => {
    const sim = new SimTytStock(SMALL);
    const dfu = await open(sim);
    expect(sameBytes(await dfu.upload(7, 1024), sim.flash.subarray(0, 1024))).toBe(true);
    await dfu.abort();
    await expect(dfu.download(0, Uint8Array.of(0x91, 0x05))).rejects.toThrow(/stall/);
    expect(sim.forbidden).toEqual([]);
    expect(sim.restarts).toBe(0);
    await dfu.clearStatus();
    await command(dfu, 0x91, 0x01);
    await command(dfu, 0x21, 0, 0, 0, 0);
    expect(sameBytes(await dfu.upload(7, 1024), sim.spi.subarray(5 * 1024, 6 * 1024))).toBe(true);
  });

  it('bootloader: the version starts with T, the factory blocks are blank, SPI ends at 1 MB', async () => {
    const sim = new SimTytStock({ mode: 'bootloader' });
    const dfu = await open(sim);
    expect(tytStockDeviceKind(dfu.interfaceName)).toBe('bootloader');
    const g = new TytStockGuard(dfu, false);
    await g.download(0, Uint8Array.of(0xa2, 0x02));
    await g.getStatus();
    await g.getStatus();
    await g.abort();
    expect(hex(await g.upload(0, 1024))).toBe('54021006');
    expect(sim.infoBlock(0x05).every((b) => b === 0xff)).toBe(true);
    expect(await command(dfu, 0x91, 0x01)).toEqual([DfuState.dfuDNBUSY, DfuState.dfuDNLOAD_IDLE]);
    await command(dfu, 0x21, 0, 0, 0, 0);
    const last = await g.upload(2 + 1023, 1024);
    expect(sameBytes(last, sim.spi.subarray(0xffc00, 0x100000))).toBe(true);
    // Above the first megabyte the answer is the stale buffer of the last good read.
    expect(sameBytes(await g.upload(2 + 1024, 1024), last)).toBe(true);
    // 91 01 is taken once; 91 05 is outside the allowlist for a bootloader.
    await g.abort();
    await expect(dfu.download(0, Uint8Array.of(0x91, 0x01))).rejects.toThrow(/stall/);
    expect(sim.forbidden).toEqual([]);
    await dfu.clearStatus();
    await expect(g.download(0, Uint8Array.of(0x91, 0x05))).rejects.toBeInstanceOf(TytStockRefused);
    expect(sim.forbidden).toEqual([]);
    await expect(dfu.download(0, Uint8Array.of(0x91, 0x05))).rejects.toThrow(/stall/);
    expect(sim.forbidden).toEqual(['DNLOAD block 0 [91 05]']);
    expect(sim.restarts).toBe(0);
  });
});

describe('a radio that is already backed up', () => {
  it('is recognised by its UID before anything slow, and left running as it was', async () => {
    const sim = new SimTytStock(SMALL);
    const asked: string[] = [];
    const result = await readTytStock(sim, 'md9600', 'all', quietContext(), (id) => {
      asked.push(id);
      return true;
    });
    expect(result).toEqual({ known: hex(sim.uid) });
    expect(asked).toEqual([hex(sim.uid)]);
    // Only the info blocks were asked for: no snapshot, no program mode, so no restart either.
    expect(sim.commands.every((command) => command.startsWith('a2 '))).toBe(true);
    expect(sim.restarts).toBe(0);
    expect(sim.forbidden).toEqual([]);
  });

  it('is read in full when its ID is not one that is known', async () => {
    const sim = new SimTytStock(SMALL);
    const result = await readTytStock(sim, 'md9600', 'quick', quietContext(), () => false);
    expect('known' in result).toBe(false);
    expect(sim.commands).toContain('91 01');
    expect(sim.restarts).toBe(1);
  });

  it('is never asked about when the radio has no ID of its own', async () => {
    const sim = new SimTytStock({ ...SMALL, uid: null });
    let asked = 0;
    const result = await readTytStock(sim, 'md9600', 'quick', quietContext(), () => {
      asked++;
      return true;
    });
    expect(asked).toBe(0);
    expect('known' in result).toBe(false);
  });
});
