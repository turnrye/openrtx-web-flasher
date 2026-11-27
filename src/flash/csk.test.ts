// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { backupCsk, flashCsk, readCsk, readCskChipId, type CskOptions } from './csk.ts';
import { FlashError, quietContext, type Progress } from './types.ts';
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

/** How a promise ended, or 'pending' when it has not ended after `ms`: a hang must fail a test, not stall it. */
async function outcome(run: Promise<unknown>, ms = 8000): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve('pending'), ms);
  });
  try {
    return await Promise.race([
      run.then(
        () => 'resolved',
        (e: unknown) => e,
      ),
      pending,
    ]);
  } finally {
    clearTimeout(timer);
  }
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
    // The RAM stub cskburn uploaded is the CSK6 burner of the pinned cskburn, unchanged: the
    // vendor step records that file's checksum next to the build.
    const build = JSON.parse(
      readFileSync(new URL('../../public/cskburn/build.json', import.meta.url), 'utf8'),
    ) as { burnerVenusSha256: string };
    expect(createHash('sha256').update(Uint8Array.from(dev.ram)).digest('hex')).toBe(build.burnerVenusSha256);
    expect(dev.trace.join(', ')).toMatch(
      /^SYNC x1, MEM_BEGIN x1, MEM_DATA x\d+, MEM_END x1, SYNC x1, CHANGE_BAUD x1, SYNC x1, FLASH_ID x1, FLASH_BEGIN x1, FLASH_DATA x76, FLASH_END x1, MD5 x1, FLASH_BEGIN x1, FLASH_DATA x45, FLASH_END x1, MD5 x1$/,
    );
    const last = seen[seen.length - 1];
    expect(last).toEqual({ phase: 'done', done: app.length + dsp.length, total: app.length + dsp.length });
    expect(seen.filter((p) => p.phase === 'write').length).toBeGreaterThan(50);
  });

  it('refuses images that overlap before anything is sent', async () => {
    const { dev, port } = sim();
    // An application that has grown past 1 MiB, written after the DSP image as the page orders them.
    const app = new Uint8Array(randomBytes(0x100000 + 4096));
    const dsp = new Uint8Array(randomBytes(64 * 1024));
    const attempt = flashCsk(
      port,
      [
        { address: 0x100000, data: dsp },
        { address: 0, data: app },
      ],
      quietContext(),
      options,
    );
    await expect(attempt).rejects.toBeInstanceOf(FlashError);
    await expect(attempt).rejects.toThrow(
      'The image written at 0x0 (1052672 bytes) runs into the one written at 0x100000. Nothing was sent to the radio.',
    );
    expect(dev.opens).toEqual([]);
    expect(dev.trace).toEqual([]);
  });

  it('writes images that only touch', async () => {
    const { dev, port } = sim();
    const first = new Uint8Array(randomBytes(0x2000));
    const second = new Uint8Array(randomBytes(0x1000));
    await flashCsk(
      port,
      [
        { address: 0x2000, data: second },
        { address: 0, data: first },
      ],
      quietContext(),
      options,
    );
    expect(Buffer.compare(dev.flash.subarray(0, 0x2000), first)).toBe(0);
    expect(Buffer.compare(dev.flash.subarray(0x2000, 0x3000), second)).toBe(0);
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

  it('fails when the radio is not in flashing mode', async () => {
    const { port } = sim({ silent: true });
    const lines: string[] = [];
    await expect(readCskChipId(port, quietContext({ log: (l) => lines.push(l) }), options)).rejects.toThrow(
      /flashing mode/,
    );
  }, 30000);

  it('reads flash back', async () => {
    const { dev, port } = sim();
    dev.flash.set([1, 2, 3, 4, 5, 6, 7, 8], 0x2000);
    const got = await readCsk(port, 0x2000, 0x100, quietContext(), options);
    expect(Array.from(got.subarray(0, 8))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(got.length).toBe(0x100);
  });

  it('backs up a whole flash, checked against the chip, with progress', async () => {
    const { dev, port } = sim({ flashSize: 96 * 1024 });
    dev.flash.set(randomBytes(dev.flash.length));
    const seen: Progress[] = [];
    const got = await readCsk(
      port,
      0,
      dev.flash.length,
      quietContext({ progress: (p) => seen.push(p) }),
      options,
    );
    expect(Buffer.compare(got, dev.flash)).toBe(0);
    expect(dev.trace.join(', ')).toContain('MD5 x1');
    expect(seen[seen.length - 1]).toEqual({ phase: 'read', done: dev.flash.length, total: dev.flash.length });
    expect(seen.filter((p) => p.phase === 'read').length).toBeGreaterThan(5);
  });

  it('fails the backup when what was read does not match the chip', async () => {
    const { dev, port } = sim({ flashSize: 16 * 1024, corruptReads: true });
    dev.flash.set(randomBytes(dev.flash.length));
    await expect(readCsk(port, 0, dev.flash.length, quietContext(), options)).rejects.toThrow();
  });

  it('stops a backup as soon as the chip turns out to be one that is already backed up', async () => {
    const { dev, port } = sim({ flashSize: 96 * 1024 });
    dev.flash.set(randomBytes(dev.flash.length));
    const lines: string[] = [];
    const asked: string[] = [];
    const result = await backupCsk(
      port,
      dev.flash.length,
      quietContext({ log: (l) => lines.push(l) }),
      options,
      (id) => {
        asked.push(id);
        return true;
      },
    );
    expect(result).toEqual({ known: 'C620240900065701' });
    expect(asked).toEqual(['C620240900065701']);
    // The chip was identified and nothing of its flash was read.
    expect(dev.trace.join(', ')).not.toContain('READ_FLASH');
    expect(lines.join('\n')).toContain('already has a backup');
    // Cut off from the radio, cskburn reports errors; none of them reaches the log.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(lines.at(-1)).toContain('already has a backup');
    expect(lines.join('\n')).not.toContain('ERROR');
  });

  it('reads the whole flash and reports the chip ID when the chip is not a known one', async () => {
    const { dev, port } = sim({ flashSize: 96 * 1024 });
    dev.flash.set(randomBytes(dev.flash.length));
    const result = await backupCsk(port, dev.flash.length, quietContext(), options, () => false);
    if ('known' in result) throw new Error('the read stopped although the chip is not known');
    expect(result.chipId).toBe('C620240900065701');
    expect(Buffer.compare(result.data, dev.flash)).toBe(0);
  });

  it('fails, and does not hang, when the serial port cannot be opened', async () => {
    const { dev, port } = sim();
    // Another program or tab has the port.
    dev.open = () => Promise.reject(new DOMException('Failed to open serial port.', 'NetworkError'));
    const app = new Uint8Array(randomBytes(40 * 1024));
    const ended = await outcome(flashCsk(port, [{ address: 0, data: app }], quietContext(), options));
    expect(ended).toBeInstanceOf(FlashError);
    expect((ended as Error).message).toMatch(/serial port could not be opened.*Failed to open serial port/);
    expect(dev.trace).toEqual([]);
  }, 20000);

  it('fails, and does not hang, when the port rejects a write part-way', async () => {
    const { dev, port } = sim();
    // The cable is pulled: from 60 KB on, every write is rejected.
    let sent = 0;
    const open = dev.open.bind(dev);
    dev.open = async (serialOptions) => {
      await open(serialOptions);
      const inner = dev.writable!.getWriter();
      dev.writable = new WritableStream<Uint8Array>({
        async write(chunk) {
          sent += chunk.length;
          if (sent > 60 * 1024) throw new DOMException('The device has been lost.', 'NetworkError');
          await inner.write(chunk);
        },
      });
    };
    const lines: string[] = [];
    const app = new Uint8Array(randomBytes(200 * 1024));
    const ended = await outcome(
      flashCsk(port, [{ address: 0, data: app }], quietContext({ log: (l) => lines.push(l) }), options),
    );
    expect(ended).toBeInstanceOf(FlashError);
    expect((ended as Error).message).toMatch(/connection to the radio was lost.*The device has been lost/);
    // Cut off from the radio, cskburn reports errors of its own; none of them reaches the log.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(lines.join('\n')).not.toContain('ERROR');
  }, 20000);

  /**
   * Makes the port's `readable` fail with `error` once, when `after` chunks have been read
   * from it and none is waiting. Like Chrome, the port then offers a fresh stream, or with
   * `gone` none at all.
   */
  function failingRead(dev: SimCsk6, error: DOMException, after: number, gone = false): void {
    const open = dev.open.bind(dev);
    dev.open = async (serialOptions) => {
      await open(serialOptions);
      const inner = dev.readable!.getReader();
      let chunks = 0;
      let failed = false;
      /** A stream that passes the radio's bytes on. */
      const passOn = (): ReadableStream<Uint8Array> =>
        new ReadableStream<Uint8Array>({
          pull: async (controller) => {
            if (!failed && chunks >= after) {
              failed = true;
              dev.readable = gone ? null : passOn();
              controller.error(error);
              return;
            }
            const { value, done } = await inner.read();
            if (done) return controller.close();
            chunks++;
            controller.enqueue(value);
          },
          cancel: () => inner.cancel(),
        });
      dev.readable = passOn();
    };
  }

  it.each(['FramingError', 'BreakError', 'BufferOverrunError', 'ParityError'])(
    'reads on after a %s, which Web Serial does not count as fatal',
    async (name) => {
      const { dev, port } = sim();
      failingRead(dev, new DOMException('A read error the port recovers from.', name), 3);
      const app = new Uint8Array(randomBytes(40 * 1024));
      const ended = await outcome(flashCsk(port, [{ address: 0, data: app }], quietContext(), options));
      expect(ended).toBe('resolved');
      expect(Buffer.compare(dev.flash.subarray(0, app.length), app)).toBe(0);
    },
    20000,
  );

  it('ends the run when the port is lost while reading', async () => {
    const { dev, port } = sim();
    failingRead(dev, new DOMException('The device has been lost.', 'NetworkError'), 3, true);
    const app = new Uint8Array(randomBytes(40 * 1024));
    const ended = await outcome(flashCsk(port, [{ address: 0, data: app }], quietContext(), options));
    expect(ended).toBeInstanceOf(FlashError);
    expect((ended as Error).message).toMatch(/connection to the radio was lost.*The device has been lost/);
  }, 20000);
});
