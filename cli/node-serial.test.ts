// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readRt4dStock } from '../src/backup/rt4d-stock.ts';
import { flashRt4d } from '../src/flash/rt4d.ts';
import { quietContext } from '../src/flash/types.ts';
import { SimRt4dStock } from '../src/sim/rt4d-stock.ts';
import { SimRt4d } from '../src/sim/rt4d.ts';
import { NodeSerialPort } from './node-serial.ts';
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
