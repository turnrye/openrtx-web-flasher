// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The DeviceEnv of the command line: real USB, serial and HID devices of this computer,
 * handed to the page's flashers in the shapes the browser gives them. Where the page
 * opens Chrome's device chooser, this finds the radio itself and asks only when more
 * than one device fits. A serial port is never guessed: it is named with --port or
 * picked from a list.
 */
import type { DeviceEnv } from '../src/devices.ts';
import { FlashError } from '../src/flash/types.ts';
import { backupFor, type Radio } from '../src/radios.ts';
import type { Io } from './io.ts';
import { NodeHidDevice, type HidInfo, type HidModule } from './node-hid.ts';
import { NodeSerialPort, type PortInfo, type SerialModule } from './node-serial.ts';

/** The part of the `usb` package this file uses: its WebUSB implementation. */
export interface UsbModule {
  WebUSB: new (options: { devicesFound: (devices: USBDevice[]) => Promise<USBDevice | undefined> }) => {
    requestDevice(options: USBDeviceRequestOptions): Promise<USBDevice>;
  };
}

/** Where the three native packages come from; each is loaded when a radio first needs it. */
export interface NodeModules {
  usb(): Promise<UsbModule>;
  serial(): Promise<SerialModule>;
  hid(): Promise<HidModule>;
}

/**
 * Loads an optional package by name. The name is not written into the import, so
 * neither the type checker nor the bundler needs the package to be there: npm leaves an
 * optional package out on a computer it cannot be installed on.
 */
export async function load<T>(name: string, what: string): Promise<T> {
  let found: { default?: T };
  try {
    found = (await import(/* @vite-ignore */ name)) as { default?: T };
  } catch {
    throw new FlashError(
      `This computer cannot reach ${what} radios from the command line: the "${name}" package is not installed here. ` +
        'Use the web page, or the usual tool for this radio.',
    );
  }
  return found.default ?? (found as T);
}

/** The packages as npm installed them. */
export const installedModules: NodeModules = {
  usb: () => load<UsbModule>('usb', 'USB'),
  serial: () => load<SerialModule>('serialport', 'serial'),
  hid: () => load<HidModule>('node-hid', 'USB HID'),
};

/** How long a control transfer may take. A TYT radio holds one back for as long as it erases a sector. */
const CONTROL_TIMEOUT_MS = 30_000;

/**
 * Makes a device of the `usb` package wait for its control transfers the way Chrome's
 * do. The package takes a time limit as a third argument and gives up after a second
 * without one; the flashers, written for Chrome, never pass it.
 */
function patient(device: USBDevice): USBDevice {
  const limited = device as USBDevice & {
    controlTransferIn(
      setup: USBControlTransferParameters,
      length: number,
      timeout?: number,
    ): Promise<USBInTransferResult>;
    controlTransferOut(
      setup: USBControlTransferParameters,
      data?: BufferSource,
      timeout?: number,
    ): Promise<USBOutTransferResult>;
  };
  const transfers: Partial<USBDevice> = {
    controlTransferIn: (setup, length) => limited.controlTransferIn(setup, length, CONTROL_TIMEOUT_MS),
    controlTransferOut: (setup, data) => limited.controlTransferOut(setup, data, CONTROL_TIMEOUT_MS),
  };
  // The device is a native object: it is left as it is, and everything else is asked of
  // it directly, with itself as `this`.
  return new Proxy(device, {
    get(target, name) {
      if (name in transfers) return transfers[name as keyof USBDevice];
      const value: unknown = Reflect.get(target, name, target);
      return typeof value === 'function' ? (value.bind(target) as unknown) : value;
    },
  });
}

/** The state `radio` must be in for `purpose`, in the page's words. */
function modeFor(radio: Radio, purpose: 'flash' | 'backup'): string {
  const backup = backupFor(radio);
  return purpose === 'backup' && backup.how === 'read' && backup.mode === 'normal'
    ? 'normal mode'
    : 'flashing mode';
}

/** The one device to use out of `found`: the only one, or the one the person picks. */
async function pickOne<T>(found: T[], label: (item: T) => string, what: string, io: Io): Promise<T> {
  if (found.length === 1) return found[0];
  const picked = await io.choose(`Which ${what} is the radio?`, found.map(label));
  if (picked !== null) return found[picked];
  throw new FlashError(
    io.interactive
      ? 'No device was chosen.'
      : `More than one ${what} fits (${found.map(label).join('; ')}). Unplug the others and try again.`,
  );
}

/** A USB device in a few words. */
function usbLabel(device: USBDevice): string {
  const id = `${device.vendorId.toString(16).padStart(4, '0')}:${device.productId.toString(16).padStart(4, '0')}`;
  return [device.productName, id, device.serialNumber].filter(Boolean).join(', ');
}

/** A serial port in a few words. */
export function portLabel(port: PortInfo): string {
  return [port.path, port.manufacturer, port.serialNumber].filter(Boolean).join(', ');
}

/** True when a HID device fits one of the page's filters. */
function fits(device: HidInfo, filters: HIDDeviceFilter[]): boolean {
  return filters.some(
    (f) =>
      (f.vendorId === undefined || f.vendorId === device.vendorId) &&
      (f.productId === undefined || f.productId === device.productId),
  );
}

/**
 * Devices of this computer. `port` is the serial port named on the command line, if one
 * was.
 */
export function nodeEnv(modules: NodeModules, io: Io, port?: string): DeviceEnv {
  return {
    simulated: false,
    // Whether a package is there is only known once it is loaded; a missing one says so then.
    supports: () => true,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),

    usb: async (filters, radio, purpose) => {
      const { WebUSB } = await modules.usb();
      const usb = new WebUSB({ devicesFound: (devices) => pickOne(devices, usbLabel, 'USB device', io) });
      try {
        return patient(await usb.requestDevice({ filters }));
      } catch (e) {
        if (e instanceof Error && e.name === 'NotFoundError') {
          throw new FlashError(
            `No ${radio.name} was found on USB. Connect it and put it in ${modeFor(radio, purpose)}.`,
          );
        }
        throw e;
      }
    },

    hid: async (filters, radio, purpose) => {
      const hid = await modules.hid();
      const found = (await hid.devicesAsync()).filter(
        (device): device is HidInfo & { path: string } => !!device.path && fits(device, filters),
      );
      if (found.length === 0) {
        throw new FlashError(
          `No ${radio.name} was found on USB. Connect it and put it in ${modeFor(radio, purpose)}.`,
        );
      }
      const picked = await pickOne(found, (d) => d.product ?? d.path, 'USB device', io);
      return new NodeHidDevice(hid, picked) as unknown as HIDDevice;
    },

    serial: async () => {
      const serial = await modules.serial();
      if (port) return new NodeSerialPort(serial, port) as unknown as SerialPort;
      const ports = await serial.SerialPort.list();
      if (ports.length === 0) {
        throw new FlashError('This computer has no serial port. Plug in the programming cable.');
      }
      const picked = await io.choose('Which serial port is the radio on?', ports.map(portLabel));
      if (picked === null) {
        throw new FlashError(
          io.interactive
            ? 'No serial port was chosen.'
            : `Say which serial port the radio is on with --port. This computer has: ${ports.map((p) => p.path).join(', ')}.`,
        );
      }
      return new NodeSerialPort(serial, ports[picked].path) as unknown as SerialPort;
    },
  };
}
