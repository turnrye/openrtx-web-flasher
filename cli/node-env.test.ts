// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { pickDevice } from '../src/flash/run.ts';
import { flashDfuSe, rawSegment } from '../src/flash/stm32dfu.ts';
import { quietContext } from '../src/flash/types.ts';
import { radioById } from '../src/radios.ts';
import { SimGd77 } from '../src/sim/gd77.ts';
import { SimRt4d } from '../src/sim/rt4d.ts';
import { SimStm32Dfu } from '../src/sim/stm32dfu.ts';
import { load, nodeEnv, type NodeModules, type UsbModule } from './node-env.ts';
import { type NodeSerialPort } from './node-serial.ts';
import { fakeIo, hidOver, serialOver } from './test-support.ts';

/** A package that must not be asked for in this test. */
function unused(): Promise<never> {
  return Promise.reject(new Error('this test must not load that package'));
}

/** A fake `usb` package that has `devices` connected and records the filters it was asked with. */
function usbWith(devices: USBDevice[]): UsbModule & { filters: USBDeviceFilter[][] } {
  const filters: USBDeviceFilter[][] = [];
  /** The package's WebUSB class: it leaves the choice to `devicesFound`, as the real one does. */
  class WebUSB {
    constructor(
      private readonly options: { devicesFound: (found: USBDevice[]) => Promise<USBDevice | undefined> },
    ) {}

    /** WebUSB.requestDevice(). */
    async requestDevice(request: USBDeviceRequestOptions): Promise<USBDevice> {
      filters.push(request.filters);
      const found = devices.filter((d) =>
        request.filters.some((f) => f.vendorId === d.vendorId && f.productId === d.productId),
      );
      const picked = found.length > 0 ? await this.options.devicesFound(found) : undefined;
      if (!picked) throw Object.assign(new Error('No device selected.'), { name: 'NotFoundError' });
      return picked;
    }
  }
  return { WebUSB, filters };
}

/** The modules of a test: only the ones it names may be loaded. */
function modules(given: Partial<NodeModules>): NodeModules {
  return { usb: unused, serial: unused, hid: unused, ...given };
}

const mod17 = radioById('mod17')!;
const md9600 = radioById('md9600')!;
const gd77 = radioById('gd77')!;
const rt4d = radioById('rt4d')!;

describe('devices of this computer for the page’s flashers', () => {
  it('finds the one USB radio in flashing mode by the page’s own filters', async () => {
    const radio = new SimStm32Dfu();
    const usb = usbWith([radio]);
    const env = nodeEnv(modules({ usb: () => Promise.resolve(usb) }), fakeIo());
    expect(env.simulated).toBe(false);
    const picked = await pickDevice(mod17, env);
    expect(picked.api).toBe('usb');
    expect(usb.filters[0]).toEqual([
      { vendorId: 0x0483, productId: 0xdf11 },
      { vendorId: 0x28e9, productId: 0x0189 },
    ]);
    // What comes back is that radio: the page's flasher writes to it and reads it back.
    const firmware = new Uint8Array(randomBytes(20 * 1024));
    const ctx = quietContext({ sleep: radio.sleep });
    await flashDfuSe(picked.device as USBDevice, [rawSegment(0x08000000, firmware)], ctx);
    expect(radio.violations).toEqual([]);
    expect(Buffer.compare(radio.read(0x08000000, firmware.length), firmware)).toBe(0);
  });

  it('lets a control transfer take as long as Chrome would, on a device it must not alter', async () => {
    /** A device like the usb package's: a native object that only works as its own `this`. */
    class Native {
      readonly vendorId = 0x0483;
      readonly productId = 0xdf11;
      readonly #timeouts: (number | undefined)[] = [];

      /** The time limits its control transfers were given. */
      get timeouts() {
        return this.#timeouts;
      }

      /** USBDevice.controlTransferIn(), with the package's optional time limit. */
      controlTransferIn(_setup: USBControlTransferParameters, length: number, timeout?: number) {
        this.#timeouts.push(timeout);
        return Promise.resolve({ status: 'ok' as const, data: new DataView(new ArrayBuffer(length)) });
      }

      /** USBDevice.controlTransferOut(), with the package's optional time limit. */
      controlTransferOut(_setup: USBControlTransferParameters, data?: BufferSource, timeout?: number) {
        this.#timeouts.push(timeout);
        return Promise.resolve({ status: 'ok' as const, bytesWritten: data?.byteLength ?? 0 });
      }

      /** USBDevice.open(). */
      open() {
        this.#timeouts.push(-1);
        return Promise.resolve();
      }
    }
    const native = new Native();
    const usb = usbWith([native as unknown as USBDevice]);
    const env = nodeEnv(modules({ usb: () => Promise.resolve(usb) }), fakeIo());
    const device = (await pickDevice(mod17, env)).device as USBDevice;
    const setup = { requestType: 'class', recipient: 'interface', request: 3, value: 0, index: 0 } as const;
    expect((await device.controlTransferIn(setup, 6)).data!.byteLength).toBe(6);
    expect((await device.controlTransferOut(setup, new Uint8Array(5))).bytesWritten).toBe(5);
    await device.open();
    // The package's default is one second, less than a TYT radio takes to erase a sector.
    expect(native.timeouts).toEqual([30_000, 30_000, -1]);
    expect(Object.keys(native)).toEqual(['vendorId', 'productId']);
    expect(device.vendorId).toBe(0x0483);
  });

  it('says which mode the radio must be in when none is found', async () => {
    const env = nodeEnv(modules({ usb: () => Promise.resolve(usbWith([])) }), fakeIo());
    await expect(pickDevice(mod17, env, 'flash')).rejects.toThrow(
      'No Module 17 was found on USB. Connect it and put it in flashing mode.',
    );
    await expect(pickDevice(md9600, env, 'backup')).rejects.toThrow('put it in normal mode');
    await expect(pickDevice(md9600, env, 'flash')).rejects.toThrow('put it in flashing mode');
  });

  it('asks which one when two USB devices fit, and refuses to guess when it cannot ask', async () => {
    const [first, second] = [new SimStm32Dfu(), new SimStm32Dfu({ productName: 'Second' })];
    /** The package with both radios connected. */
    const usb = () => Promise.resolve(usbWith([first, second]));

    const io = fakeIo([1]);
    const picked = await pickDevice(mod17, nodeEnv(modules({ usb }), io));
    expect((picked.device as USBDevice).productName).toBe('Second');
    expect(io.asked[0]).toContain('Second, 0483:df11, SIM0001');

    await expect(pickDevice(mod17, nodeEnv(modules({ usb }), fakeIo()))).rejects.toThrow(
      'More than one USB device fits',
    );
    await expect(pickDevice(mod17, nodeEnv(modules({ usb }), fakeIo([null])))).rejects.toThrow(
      'No device was chosen.',
    );
  });

  it('never guesses a serial port: it is named, or picked from the list', async () => {
    const serial = serialOver(new SimRt4d(), [
      { path: '/dev/ttyUSB0', manufacturer: 'Silicon Labs' },
      { path: '/dev/ttyUSB1' },
    ]);
    const load = { serial: () => Promise.resolve(serial) };

    const named = await pickDevice(rt4d, nodeEnv(modules(load), fakeIo(), '/dev/ttyUSB7'));
    expect((named.device as unknown as NodeSerialPort).path).toBe('/dev/ttyUSB7');

    const io = fakeIo([1]);
    const picked = await pickDevice(rt4d, nodeEnv(modules(load), io));
    expect((picked.device as unknown as NodeSerialPort).path).toBe('/dev/ttyUSB1');
    expect(io.asked[0]).toBe('Which serial port is the radio on? /dev/ttyUSB0, Silicon Labs | /dev/ttyUSB1');

    await expect(pickDevice(rt4d, nodeEnv(modules(load), fakeIo()))).rejects.toThrow(
      'Say which serial port the radio is on with --port. This computer has: /dev/ttyUSB0, /dev/ttyUSB1.',
    );
    // Nothing was opened by looking.
    expect(serial.constructed).toEqual([]);
  });

  it('says so when the computer has no serial port', async () => {
    const serial = serialOver(new SimRt4d(), []);
    const env = nodeEnv(modules({ serial: () => Promise.resolve(serial) }), fakeIo([0]));
    await expect(pickDevice(rt4d, env)).rejects.toThrow('This computer has no serial port.');
  });

  it('finds the GD-77 among the HID devices and passes over the others', async () => {
    const sim = new SimGd77({ model: 'GD-77' });
    const env = nodeEnv(modules({ hid: () => Promise.resolve(hidOver(sim)) }), fakeIo());
    const picked = await pickDevice(gd77, env);
    expect(picked.api).toBe('hid');
    expect((picked.device as HIDDevice).vendorId).toBe(0x15a2);
    await (picked.device as HIDDevice).open();
    expect(sim.opened).toBe(true);
  });

  it('says so when no HID radio is connected', async () => {
    const none = { devicesAsync: () => Promise.resolve([]), HIDAsync: { open: unused } };
    const env = nodeEnv(modules({ hid: () => Promise.resolve(none) }), fakeIo());
    await expect(pickDevice(gd77, env, 'backup')).rejects.toThrow(
      'No Radioddity GD-77 was found on USB. Connect it and put it in normal mode.',
    );
  });

  it('explains a package that is not installed instead of failing with a module error', async () => {
    await expect(load('openrtx-flasher-no-such-package', 'USB')).rejects.toThrow(
      'This computer cannot reach USB radios from the command line: the "openrtx-flasher-no-such-package" package is not installed here.',
    );
  });
});
