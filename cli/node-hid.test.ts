// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readGd77Stock } from '../src/backup/gd77-stock.ts';
import { flashGd77, parseSgl } from '../src/flash/gd77.ts';
import { quietContext } from '../src/flash/types.ts';
import { SimGd77Stock } from '../src/sim/gd77-stock.ts';
import { buildSgl, SimGd77 } from '../src/sim/gd77.ts';
import { NodeHidDevice } from './node-hid.ts';
import { hidOver } from './test-support.ts';

/** A Node HID device whose far end is the simulated radio `sim`, typed as the flashers want it. */
function deviceOver(sim: HIDDevice) {
  const device = new NodeHidDevice(hidOver(sim), {
    vendorId: sim.vendorId,
    productId: sim.productId,
    path: 'radio',
    product: 'Radio',
  });
  return { device, web: device as unknown as HIDDevice };
}

describe('a HID device of this computer as a WebHID device', () => {
  it('carries the page’s GD-77 flasher to a simulated radio without a report descriptor', async () => {
    const sim = new SimGd77({ model: 'GD-77' });
    const { device, web } = deviceOver(sim);
    const sgl = buildSgl(new Uint8Array(randomBytes(40 * 1024)), 'GD-77');
    const log: string[] = [];
    await flashGd77(web, sgl, 'GD-77', quietContext({ log: (line) => log.push(line) }));
    expect(sim.errors).toEqual([]);
    expect(sim.complete).toBe(true);
    expect(Buffer.compare(sim.payload, parseSgl(sgl).payload)).toBe(0);
    // No descriptor to read, so the flasher used the framing it knows the radio to have.
    expect(device.collections).toEqual([]);
    expect(log[0]).toBe('HID framing: report 0x01, 41 bytes');
    // Every report went out with its ID in front, as hidapi wants it.
    expect(sim.sent.every(([id, data]) => id === 1 && data.length === 41)).toBe(true);
    expect(device.opened).toBe(false);
  });

  it('carries the page’s GD-77 reader, and only reads', async () => {
    const sim = new SimGd77Stock({ model: 'GD-77' });
    const { web } = deviceOver(sim);
    const backup = await readGd77Stock(web, 'GD-77', quietContext());
    expect(sim.forbidden).toEqual([]);
    expect(backup.parts.length).toBeGreaterThan(0);
    for (const part of backup.parts) {
      const held = sim.memory(part.address!, part.address! + part.data.length);
      expect(Buffer.compare(part.data, held), part.file).toBe(0);
    }
  });

  it('is closed until opened, and refuses a report while closed', async () => {
    const { device } = deviceOver(new SimGd77({ model: 'DM-1801' }));
    expect(device.opened).toBe(false);
    await expect(device.sendReport(1, new Uint8Array(4))).rejects.toThrow('closed');
    await device.open();
    expect(device.opened).toBe(true);
    await expect(device.open()).rejects.toThrow('already open');
    await device.close();
    await device.close();
    expect(device.opened).toBe(false);
  });
});
