// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { readRt4dStock } from '../src/backup/rt4d-stock.ts';
import { flashRt4d } from '../src/flash/rt4d.ts';
import { quietContext } from '../src/flash/types.ts';
import { SimRt4dStock } from '../src/sim/rt4d-stock.ts';
import { SimRt4d } from '../src/sim/rt4d.ts';
import { NodeSerialPort, type NativePort, type SerialModule } from './node-serial.ts';
import { serialOver } from './test-support.ts';

/** A Node serial port whose far end is the simulated radio `device`, typed as the flashers want it. */
function portOver(device: object) {
  const serial = serialOver(device as SerialPort);
  const port = new NodeSerialPort(serial, '/dev/fake');
  return { serial, port, web: port as unknown as SerialPort };
}

describe('a serial port of this computer as a Web Serial port', () => {
  it('carries the page’s RT-4D flasher to a simulated radio, byte for byte', async () => {
    const sim = new SimRt4d();
    const { serial, web } = portOver(sim);
    const firmware = new Uint8Array(randomBytes(100 * 1024));
    await flashRt4d(web, firmware, quietContext());
    expect(sim.errors).toEqual([]);
    expect(sim.complete).toBe(true);
    expect(Buffer.compare(sim.flash.subarray(0, firmware.length), firmware)).toBe(0);
    expect(serial.constructed).toEqual([{ path: '/dev/fake', baudRate: 115200 }]);
    // The flasher closed the port again.
    expect(web.readable).toBeNull();
  });

  it('carries the page’s RT-4D reader, and only reads', async () => {
    const sim = new SimRt4dStock();
    const { web } = portOver(sim);
    const backup = await readRt4dStock(web, 'quick', quietContext());
    expect(sim.forbidden).toEqual([]);
    const part = backup.parts[0];
    expect(part.complete).toBe(true);
    expect(Buffer.compare(part.data, sim.flash.subarray(0, part.data.length))).toBe(0);
  });

  it('says so when the radio does not answer', async () => {
    const { web } = portOver(new SimRt4d({ silent: true }));
    await expect(
      flashRt4d(web, new Uint8Array(1024), quietContext(), { responseTimeoutMs: 50 }),
    ).rejects.toThrow('The radio did not answer. Is it connected and in flashing mode?');
  });

  it('behaves like Chrome’s port around open and close', async () => {
    const { port, serial } = portOver(new SimRt4d());
    expect(port.readable).toBeNull();
    expect(port.writable).toBeNull();
    await expect(port.close()).rejects.toThrow('already closed');
    await expect(port.setSignals({ dataTerminalReady: true })).rejects.toThrow('closed');

    await port.open({ baudRate: 9600 });
    await expect(port.open({ baudRate: 9600 })).rejects.toThrow('already open');
    await port.setSignals({ dataTerminalReady: false, requestToSend: true });
    await port.setSignals({ requestToSend: false });
    expect(serial.signals).toEqual([{ dtr: false, rts: true }, { rts: false }]);

    // A locked stream keeps the port open; a cancelled one is replaced by a fresh one.
    const first = port.readable!;
    const reader = first.getReader();
    await expect(port.close()).rejects.toThrow('locked');
    await reader.cancel();
    reader.releaseLock();
    expect(port.readable).not.toBe(first);
    await port.close();
    expect(port.readable).toBeNull();
  });

  it('keeps what arrives before anyone reads', async () => {
    const sim = new SimRt4d({ noise: [1, 2, 3] });
    const { port } = portOver(sim);
    await port.open({ baudRate: 115200 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reader = port.readable!.getReader();
    expect(Array.from((await reader.read()).value!)).toEqual([1, 2, 3]);
    await reader.cancel();
    reader.releaseLock();
    await port.close();
  });
});

/**
 * A port whose reads wait for its poller to report the port readable, as serialport's do,
 * and whose poller never does by itself, as kqueue with a CH340 on macOS. Whatever is
 * written is answered with `answer` at once, but only a read that wakes finds it.
 */
function stallingSerial(answer: Uint8Array): SerialModule {
  const poller = new EventEmitter();
  let ready: Uint8Array | null = null;
  let listener: ((data: Uint8Array) => void) | null = null;
  /** serialport's read: look, and wait for the poller when there is nothing yet. */
  const read = () =>
    poller.once('readable', () => {
      if (ready) listener?.(ready);
      ready = null;
      read();
    });

  /** One port of the stalling package. */
  class Port implements NativePort {
    readonly port = { poller };
    open(done: (error?: Error | null) => void) {
      read();
      done(null);
    }
    close(done: (error?: Error | null) => void) {
      done(null);
    }
    write(_data: Uint8Array, done: (error?: Error | null) => void) {
      ready = answer;
      done(null);
    }
    drain(done: (error?: Error | null) => void) {
      done(null);
    }
    set(_signals: object, done: (error?: Error | null) => void) {
      done(null);
    }
    on(event: 'data' | 'error' | 'close', l: (data: never) => void) {
      if (event === 'data') listener = l as (data: Uint8Array) => void;
      return this;
    }
  }
  return { SerialPort: Object.assign(Port, { list: async () => [] }) };
}

/** The first chunk `port` reads within `ms`, or null. */
async function firstRead(port: NodeSerialPort, ms: number): Promise<number[] | null> {
  await port.open({ baudRate: 115200 });
  const reader = port.readable!.getReader();
  const writer = port.writable!.getWriter();
  await writer.write(Uint8Array.of(0x42));
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));
  const got = await Promise.race([reader.read().then((r) => Array.from(r.value!)), timeout]);
  await reader.cancel();
  reader.releaseLock();
  writer.releaseLock();
  await port.close();
  return got;
}

describe('reads a poller never wakes (macOS kqueue and a CH340)', () => {
  it('stall without the wake-up', async () => {
    const port = new NodeSerialPort(stallingSerial(Uint8Array.of(0xe5)), '/dev/fake', 0);
    expect(await firstRead(port, 50)).toBeNull();
  });

  it('arrive with it', async () => {
    const port = new NodeSerialPort(stallingSerial(Uint8Array.of(0xe5)), '/dev/fake', 2);
    expect(await firstRead(port, 500)).toEqual([0xe5]);
  });
});
