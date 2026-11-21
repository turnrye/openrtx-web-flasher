// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { flashCsk, readCsk, readCskChipId, type CskOptions } from './csk.ts';
import { quietContext, type Progress } from './types.ts';
import { SimCsk6 } from '../sim/csk6.ts';

const options: CskOptions = {
  loadModule: async () => (await import('../../public/cskburn/cskburn.mjs')).default,
};
const md5 = (bytes: Uint8Array) => new Uint8Array(createHash('md5').update(bytes).digest());

/** A simulated C62 typed as the SerialPort the flasher expects. */
function sim(extra: Partial<ConstructorParameters<typeof SimCsk6>[0]> = {}) {
  const dev = new SimCsk6({ md5, ...extra });
  return { dev, port: dev as unknown as SerialPort };
}

describe('cskburn (C62) over a simulated serial port', () => {
  it('reads the chip ID', async () => {
    const { port } = sim();
    expect(await readCskChipId(port, quietContext(), options)).toBe('C620240900065701');
  });

  it('writes and verifies the app and DSP images', async () => {
    const { dev, port } = sim();
    const app = new Uint8Array(randomBytes(300 * 1024 + 123));
    const dsp = new Uint8Array(randomBytes(180 * 1024));
    const seen: Progress[] = [];
    await flashCsk(
      port,
      [
        { address: 0x0, data: app },
        { address: 0x100000, data: dsp },
      ],
      quietContext({ progress: (p) => seen.push(p) }),
      options,
    );
    expect(Buffer.compare(dev.flash.subarray(0, app.length), app)).toBe(0);
    expect(Buffer.compare(dev.flash.subarray(0x100000, 0x100000 + dsp.length), dsp)).toBe(0);
    // The RAM stub cskburn uploaded is its bundled CSK6 burner, unchanged.
    const burner = readFileSync(new URL('../../tools/cskburn-wasm/burner_venus.sha256', import.meta.url), 'utf8');
    expect(createHash('sha256').update(Uint8Array.from(dev.ram)).digest('hex')).toBe(burner.trim());
    expect(dev.trace.join(', ')).toMatch(
      /^SYNC x1, MEM_BEGIN x1, MEM_DATA x\d+, MEM_END x1, SYNC x1, CHANGE_BAUD x1, SYNC x1, FLASH_ID x1, FLASH_BEGIN x1, FLASH_DATA x76, FLASH_END x1, MD5 x1, FLASH_BEGIN x1, FLASH_DATA x45, FLASH_END x1, MD5 x1$/,
    );
    const last = seen[seen.length - 1];
    expect(last).toEqual({ phase: 'done', done: app.length + dsp.length, total: app.length + dsp.length });
    expect(seen.filter((p) => p.phase === 'write').length).toBeGreaterThan(50);
  });

  it('reopens the port for a faster burn baud', async () => {
    const { dev, port } = sim();
    const app = new Uint8Array(randomBytes(40 * 1024));
    await flashCsk(port, [{ address: 0, data: app }], quietContext(), { ...options, baud: 1500000 });
    expect(dev.opens).toEqual([115200, 1500000, 115200, 1500000]);
    expect(Buffer.compare(dev.flash.subarray(0, app.length), app)).toBe(0);
  });

  it('fails when the chip reports a different MD5', async () => {
    const { port } = sim({ corruptAt: 5000 });
    const app = new Uint8Array(randomBytes(40 * 1024));
    await expect(flashCsk(port, [{ address: 0, data: app }], quietContext(), options)).rejects.toThrow();
  });

  it('fails when the radio is not in burn mode', async () => {
    const { port } = sim({ silent: true });
    const lines: string[] = [];
    await expect(readCskChipId(port, quietContext({ log: (l) => lines.push(l) }), options)).rejects.toThrow(
      /burn mode/,
    );
  }, 30000);

  it('reads flash back', async () => {
    const { dev, port } = sim();
    dev.flash.set([1, 2, 3, 4, 5, 6, 7, 8], 0x2000);
    const got = await readCsk(port, 0x2000, 0x100, quietContext(), options);
    expect(Array.from(got.subarray(0, 8))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(got.length).toBe(0x100);
  });
});
