// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What a flashing method declares about itself: one `Driver` object per method, in the
 * file named after it. Everything that used to ask "which method is this?" looks the
 * driver up (`driverFor`) and asks it instead.
 */
import type { AlreadyBackedUp, BackupScope, Known, RadioBackup } from '../backup/types.ts';
import type { WebApi } from '../devices.ts';
import type { BackupOrigin, Purpose } from '../flash/run.ts';
import type { FlashContext, Segment } from '../flash/types.ts';
import type { Backup, Radio } from '../radios.ts';
import type { SimProbe, SimStockProbe } from '../sim/env.ts';

/** What a flash is given, besides the device. */
export interface FlashJob {
  radio: Radio;
  firmware: Uint8Array;
  ctx: FlashContext;
  /** Set when `firmware` is the image out of a backup: what that backup says about its radio. */
  restore: BackupOrigin | null;
  /** The other images of the build that the radio needs (`Radio.alsoWrites`). */
  also: Segment[];
}

/** What a backup read is given, besides the device. */
export interface ReadJob {
  radio: Radio;
  /** How much to read, for the readers that know more than one amount. */
  scope: BackupScope;
  ctx: FlashContext;
  /** How many bytes to read when that is not the radio's real size (simulated radios are small). */
  size?: number;
  /** Asked as soon as the radio's ID is known; true ends the read there. */
  known?: Known;
}

/** What every driver says, whether or not the page talks to the radio. */
interface Described {
  /** What backing up `radio` involves: the data `backupFor` returns. */
  backup: (radio: Radio) => Backup;
  /** Whether the ID a backup read finds first belongs to one radio only (`idIsPerUnit`). Absent: it does not. */
  idIsPerUnit?: (radio: Radio) => boolean;
}

/** A method that talks to the radio through a browser API, with that API's device object. */
export interface DeviceDriver<Api extends WebApi, Device> extends Described {
  /** The browser API the method needs. */
  api: Api;
  /** Writes the firmware with the method's flasher. */
  flash: (device: Device, job: FlashJob) => Promise<void>;
  /** Reads the radio for a backup, in the mode `backup` names. Absent when the method cannot read. */
  read?: (device: Device, job: ReadJob) => Promise<RadioBackup | AlreadyBackedUp>;
  /**
   * Loads the method's simulated radios (src/drivers/sims.ts). A dynamic import, so that
   * only `?sim=`, the command line's `--sim` and tests ever load a simulator.
   */
  simulator: () => Promise<Simulator<Device>>;
  /** How much of its simulated radio a backup reads, when the real size would take minutes. */
  simBackupSize?: number;
}

/** A method over WebUSB. */
export interface UsbDriver extends DeviceDriver<'usb', USBDevice> {
  /** The devices to offer in the chooser. */
  filters: USBDeviceFilter[];
  /**
   * True when the device is a USB drive. Browsers keep those from web pages and the
   * operating system holds them, so only the command line reaches one, and only by
   * taking it over.
   */
  massStorage?: boolean;
}

/** A method over WebHID. */
export interface HidDriver extends DeviceDriver<'hid', HIDDevice> {
  /** The devices to offer in the chooser. */
  filters: HIDDeviceFilter[];
}

/** A method over Web Serial. A serial port says nothing about what is on it, so there are no filters. */
export interface SerialDriver extends DeviceDriver<'serial', SerialPort> {
  /**
   * True when the flasher runs cskburn. The page loads it as WebAssembly from beside
   * itself; anything else says where it comes from first (`setCskburnLoader`).
   */
  cskburn?: boolean;
}

/** A method the page does not carry out: the person does it by hand. */
export interface ManualDriver extends Described {
  api: null;
  /** Why there is no device to pick and nothing to flash, for the user. */
  byHand: string;
}

/** One flashing method. */
export type Driver = UsbDriver | HidDriver | SerialDriver | ManualDriver;

/** What the simulated environment asks of a method's simulator. */
export interface SimRequest {
  radio: Radio;
  /** Flashing, or a backup: for some radios those are the bootloader and the original firmware. */
  purpose: Purpose;
  /** `?sim=fail`: a radio that does not answer. */
  fail: boolean;
  /** `?sim=wrongmode`: a radio in the wrong state for `purpose`. */
  wrongMode: boolean;
  /** `?sim=protected`: a radio whose flash cannot be read out, where the method has such a thing. */
  readProtected: boolean;
  /** Milliseconds the radio takes over each request (`?sim=slow`); 0 for none. */
  delay: number;
}

/** One simulated radio, as its device object and what can be asked about it afterwards. */
export interface SimRadio<Device> {
  device: Device;
  /** The simulator's own clock, where it keeps one to check poll timing. */
  sleep?: (ms: number) => Promise<void>;
  /** For a radio that is flashed or read in flashing mode: becomes `window.__ortxSim`. */
  probe?: Omit<SimProbe, 'radioId'>;
  /** For a radio read through its original firmware: becomes `window.__ortxSimStock`. */
  stockProbe?: Omit<SimStockProbe, 'radioId'>;
}

/** A method's simulated radios. */
export interface Simulator<Device> {
  /** Makes the simulated radio for one request of the device chooser. */
  make: (request: SimRequest) => SimRadio<Device>;
}
