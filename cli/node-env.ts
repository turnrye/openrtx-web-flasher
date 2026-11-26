// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The DeviceEnv of the command line: real USB, serial and HID devices of this computer,
 * handed to the page's flashers in the shapes the browser gives them. Where the page
 * opens Chrome's device chooser, this finds the radio itself and asks only when more
 * than one device fits. A serial port is never guessed: it is named with --port or
 * picked from a list.
 */
import { accessSync, constants } from 'node:fs';
import type { DeviceEnv } from '../src/devices.ts';
import { FlashError } from '../src/flash/types.ts';
import { backupFor, type Radio } from '../src/radios.ts';
import type { Io } from './io.ts';
import { NodeHidDevice, type HidInfo, type HidModule } from './node-hid.ts';
import { NodeSerialPort, type PortInfo, type SerialModule } from './node-serial.ts';

/** A device as the libusb `usb` package lists it, before WebUSB has opened it. */
export interface ListedUsbDevice {
  deviceDescriptor: { idVendor: number; idProduct: number };
  open(): void;
  close(): void;
}

/**
 * The part of a `usb` package this file uses: its WebUSB implementation and, in the
 * libusb one, the plain device list.
 */
export interface UsbModule {
  WebUSB: new (options: { devicesFound: (devices: USBDevice[]) => Promise<USBDevice | undefined> }) => {
    requestDevice(options: USBDeviceRequestOptions): Promise<USBDevice>;
  };
  getDeviceList?(): ListedUsbDevice[];
}

/**
 * The radio is there, but this user may not open it. On Linux that is the device's
 * permissions, which "openrtx-flasher setup" fixes; main offers it when this is thrown.
 */
export class NoAccessError extends FlashError {
  constructor(message: string) {
    super(message);
    this.name = 'NoAccessError';
  }
}

/** True when a USB or HID library's error means "permission denied". */
export function isRefusal(why: string): boolean {
  return /LIBUSB_ERROR_ACCESS|permission denied|errno 13|EACCES/i.test(why);
}

/** The text of a thrown value. */
function textOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** What to say when the radio is there but this user may not open it. */
export function noAccess(radio: Radio, why: string): string {
  return `The ${radio.name} is connected, but this user may not open it (${why}).`;
}

/**
 * Why a device that fits `filters` is connected but was not offered: the libusb package
 * leaves out, without a word, every device it cannot open. Null when none fits, or the
 * package cannot list devices itself.
 */
function whyLeftOut(usb: UsbModule, filters: USBDeviceFilter[]): string | null {
  const listed = (usb.getDeviceList?.() ?? []).filter(({ deviceDescriptor: d }) =>
    filters.some((f) => f.vendorId === d.idVendor && f.productId === d.idProduct),
  );
  for (const device of listed) {
    try {
      device.open();
      device.close();
    } catch (e) {
      return textOf(e);
    }
  }
  return null;
}

/**
 * Opens and closes `device` once, so a refusal is found before anything is sent to the
 * radio and not halfway through a flash. Opening sends nothing to the device.
 */
async function tryOpening(device: USBDevice, radio: Radio): Promise<void> {
  try {
    await device.open();
  } catch (e) {
    if (isRefusal(textOf(e))) throw new NoAccessError(noAccess(radio, textOf(e)));
    throw e;
  }
  await device.close();
}

/** Where the three native packages come from; each is loaded when a radio first needs it. */
export interface NodeModules {
  /**
   * The USB package. For 'storage' it is the one built on libusb, which can take a USB
   * drive over from the operating system's own driver; the other one cannot on a Mac.
   */
  usb(kind?: 'storage'): Promise<UsbModule>;
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
  usb: (kind) => load<UsbModule>(kind === 'storage' ? 'usb-libusb' : 'usb', 'USB'),
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
  return replacing(device, transfers);
}

/**
 * `device` with some of its members replaced. The device is a native object: it is left
 * as it is, and everything else is asked of it directly, with itself as `this`.
 */
function replacing(device: USBDevice, members: Partial<USBDevice>): USBDevice {
  return new Proxy(device, {
    get(target, name) {
      if (name in members) return members[name as keyof USBDevice];
      const value: unknown = Reflect.get(target, name, target);
      return typeof value === 'function' ? (value.bind(target) as unknown) : value;
    },
  });
}

/** How long a bulk transfer to a USB drive may take before it is called off. */
const BULK_TIMEOUT_MS = 2_000;

/** What to do when this computer will not hand a radio's USB drive over; `why` is the library's word for it. */
export function driveRefusal(why: string, platform: string = process.platform): string {
  if (!/ACCESS|NOT_SUPPORTED|BUSY/.test(why)) return `Could not take over the radio's USB drive: ${why}`;
  switch (platform) {
    case 'darwin':
      return 'macOS keeps USB drives to itself. Run the command again with "sudo" in front: that lets it take the radio over for as long as the flash lasts.';
    case 'win32':
      return 'Windows keeps this kind of USB device to itself. Use the Connect Systems Factory Tool with the .bin file instead.';
    default:
      return 'This user may not use the radio\'s USB device. "openrtx-flasher setup" lets the person logged in at this computer use it.';
  }
}

/** The part of the libusb package's own device that sets how long bulk transfers may take. */
interface LibusbDevice {
  interfaces?: { endpoints: { timeout: number }[] }[];
}

/**
 * Makes a device of the libusb `usb` package fit for a USB drive. Claiming the interface
 * is where the operating system's driver is pushed aside, so that is where a refusal is
 * put into words; and the package lets a bulk transfer wait for ever, so each endpoint
 * gets a time limit once the interface is claimed.
 */
function takingOver(device: USBDevice): USBDevice {
  return replacing(device, {
    claimInterface: async (interfaceNumber) => {
      try {
        await device.claimInterface(interfaceNumber);
      } catch (e) {
        throw new FlashError(driveRefusal(e instanceof Error ? e.message : String(e)));
      }
      const inner = (device as unknown as { device?: LibusbDevice }).device;
      for (const iface of inner?.interfaces ?? []) {
        for (const endpoint of iface.endpoints) endpoint.timeout = BULK_TIMEOUT_MS;
      }
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
 * was. `platform` is process.platform's name for the system, which main passes: on
 * 'linux' a radio this user may not open is a NoAccessError, not "not found". Left out,
 * no system's checks are made, so a test behaves the same on every computer.
 */
export function nodeEnv(modules: NodeModules, io: Io, port?: string, platform = ''): DeviceEnv {
  return {
    simulated: false,
    // Whether a package is there is only known once it is loaded; a missing one says so then.
    supports: () => true,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),

    usb: async (filters, radio, purpose) => {
      const drive = radio.method === 'cs7000-robot';
      const usbModule = await modules.usb(drive ? 'storage' : undefined);
      const usb = new usbModule.WebUSB({
        devicesFound: (devices) => pickOne(devices, usbLabel, 'USB device', io),
      });
      try {
        const device = await usb.requestDevice({ filters });
        if (platform === 'linux' && !drive) await tryOpening(device, radio);
        return drive ? takingOver(device) : patient(device);
      } catch (e) {
        if (e instanceof Error && e.name === 'NotFoundError') {
          const why = platform === 'linux' ? whyLeftOut(usbModule, filters) : null;
          if (why && isRefusal(why)) throw new NoAccessError(noAccess(radio, why));
          if (why) throw new FlashError(`The ${radio.name} is connected, but could not be opened: ${why}`);
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
      if (platform === 'linux' && picked.path.startsWith('/')) {
        try {
          accessSync(picked.path, constants.R_OK | constants.W_OK);
        } catch (e) {
          if (isRefusal(textOf(e))) throw new NoAccessError(noAccess(radio, textOf(e)));
        }
      }
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
