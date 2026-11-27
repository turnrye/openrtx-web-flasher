// SPDX-License-Identifier: GPL-3.0-or-later
/** Picks the device and the flasher for a radio. The only place that knows every method. */
import { siteUrl } from '../base.ts';
import { isSimulated, type DeviceEnv } from '../devices.ts';
import { readStock } from '../backup/stock.ts';
import {
  isAlready,
  type AlreadyBackedUp,
  type IdKind,
  type Known,
  type RadioBackup,
} from '../backup/types.ts';
import { backupFor, type Radio } from '../radios.ts';
import { flashCs7000Robot, SECOND_SLOT } from './cs7000-robot.ts';
import { backupCsk, flashCsk, type CskModuleLoader } from './csk.ts';
import { flashGd77 } from './gd77.ts';
import { flashRt4d } from './rt4d.ts';
import { flashRt950 } from './rt950.ts';
import { flashDfuSe, parseDfuFile, rawSegment, readDfuSe } from './stm32dfu.ts';
import { flashTyt } from './tyt.ts';
import { FlashError, WrongRadioError, type FlashContext, type Segment } from './types.ts';

/** STM32 and GD32 ROM bootloaders, and the TYT bootloader that borrows ST's IDs. */
const DFU_FILTERS: USBDeviceFilter[] = [
  { vendorId: 0x0483, productId: 0xdf11 },
  { vendorId: 0x28e9, productId: 0x0189 },
];

/** The Connect Systems bootloader of the CS7000-M17 Plus in robot mode: a USB drive. */
const CS7000_ROBOT_FILTERS: USBDeviceFilter[] = [{ vendorId: 0x0483, productId: 0x5720 }];

/** NXP MK22 bootloader of the GD-77 family. */
const GD77_FILTERS: HIDDeviceFilter[] = [{ vendorId: 0x15a2, productId: 0x0073 }];

/** Loads the cskburn WebAssembly module that ships next to the page. */
let loadCskburn: CskModuleLoader = async () => {
  const url = siteUrl('cskburn/cskburn.mjs');
  const module = (await import(/* @vite-ignore */ url)) as { default: Awaited<ReturnType<CskModuleLoader>> };
  return module.default;
};

/** Replaces where cskburn comes from. The command line has no page to load it next to, so it brings its own. */
export function setCskburnLoader(loader: CskModuleLoader): void {
  loadCskburn = loader;
}

/** A device the user picked, ready for `flashDevice`. */
export type PickedDevice =
  | { api: 'usb'; device: USBDevice }
  | { api: 'serial'; device: SerialPort }
  | { api: 'hid'; device: HIDDevice };

/** What a device is wanted for: the two can be different devices of the same radio. */
export type Purpose =
  /** Writing firmware: the radio is in its flashing mode. */
  | 'flash'
  /** Reading a backup: flashing mode, or the original firmware, as `backupFor` says. */
  | 'backup';

/**
 * Opens the browser's device chooser for `radio`. Call this directly from a click: the
 * browser only shows the chooser in response to one.
 */
export async function pickDevice(
  radio: Radio,
  env: DeviceEnv,
  purpose: Purpose = 'flash',
): Promise<PickedDevice> {
  switch (radio.method) {
    case 'tyt-dfu':
    case 'stm32-dfu':
      return { api: 'usb', device: await env.usb(DFU_FILTERS, radio, purpose) };
    case 'cs7000-robot':
      return { api: 'usb', device: await env.usb(CS7000_ROBOT_FILTERS, radio, purpose) };
    case 'gd77-hid':
      return { api: 'hid', device: await env.hid(GD77_FILTERS, radio, purpose) };
    case 'rt4d-serial':
    case 'rt950-serial':
    case 'csk-serial':
      return { api: 'serial', device: await env.serial(radio, purpose) };
    case 'uf2-copy':
      throw new FlashError('This radio is flashed by copying the file onto its USB drive.');
  }
}

/** Where the internal flash of the STM32 radios starts; a backup is an image of it from here. */
const STM32_FLASH_BASE = 0x08000000;

/** A USB device's serial number, or null when it reports none. */
function usbSerial(dev: USBDevice): string | null {
  const serial = dev.serialNumber?.trim();
  return serial === undefined || serial === '' ? null : serial;
}

/** The CSK6's flash size on the C62 and C2. */
const C62_FLASH_SIZE = 4 * 1024 * 1024;

/**
 * Reads the radio for a backup, the way `backupFor(radio)` describes: everything the
 * page can read. `size` overrides how much of a C62 is read (the simulated one has a
 * small flash). `known` is asked as soon as the radio's ID is known; when it says the
 * radio is already backed up, nothing more is read. A backup of a simulated radio says
 * that it is one.
 */
export async function backupDevice(
  radio: Radio,
  picked: PickedDevice,
  ctx: FlashContext,
  size?: number,
  known?: Known,
): Promise<RadioBackup | AlreadyBackedUp> {
  const read = await readDevice(radio, picked, ctx, size, known);
  if (!isAlready(read) && isSimulated(picked.device)) read.simulated = true;
  return read;
}

/** The read behind `backupDevice`. */
async function readDevice(
  radio: Radio,
  picked: PickedDevice,
  ctx: FlashContext,
  size?: number,
  known?: Known,
): Promise<RadioBackup | AlreadyBackedUp> {
  const backup = backupFor(radio);
  if (backup.how !== 'read') throw new FlashError('This radio cannot be read out.');
  if (backup.mode === 'normal') return readStock(radio, picked.device, 'all', ctx, known);
  switch (radio.method) {
    case 'stm32-dfu': {
      const dev = picked.device as USBDevice;
      const serial = usbSerial(dev);
      if (serial !== null && known?.(serial)) return { known: serial };
      const image = await readDfuSe(dev, ctx, { chip: radio.chip });
      return {
        radioId: usbSerial(dev),
        idKind: usbSerial(dev) ? 'usb-serial' : null,
        notes: [],
        parts: [
          {
            file: 'internal-flash.bin',
            kind: 'internal-flash',
            address: image.address,
            data: image.data,
            complete: true,
          },
        ],
      };
    }
    case 'csk-serial': {
      const read = await backupCsk(
        picked.device as SerialPort,
        size ?? C62_FLASH_SIZE,
        ctx,
        { loadModule: loadCskburn },
        known,
      );
      if ('known' in read) return read;
      const { data, chipId } = read;
      const whole = data.length === C62_FLASH_SIZE;
      return {
        radioId: chipId,
        idKind: chipId ? 'chip-id' : null,
        notes: ['cskburn checked what it read against a checksum the chip computed.'],
        parts: [
          {
            file: 'flash.bin',
            kind: 'internal-flash',
            address: 0,
            data,
            // A shorter read (only ever asked for by the simulator) can still be written back.
            complete: true,
            note: whole ? undefined : `The first ${data.length} bytes of the flash only.`,
          },
        ],
      };
    }
    default:
      throw new FlashError('This radio cannot be read out.');
  }
}

/**
 * What a backup says about the radio it was read from: its manifest (`BundleManifest`)
 * is one.
 */
export interface BackupOrigin {
  radioId: string | null;
  idKind: IdKind | null;
  /** Set when the backup was read from a simulated radio. */
  simulated?: boolean;
}

/** Why a backup of a simulated radio is not written to a real one. */
export const SIMULATED_BACKUP =
  'This backup was read from a simulated radio, not a real one, so it cannot be written to a real radio. ' +
  'Nothing was sent to the radio.';

/**
 * Why the backup that `origin` describes must not be written to the picked device, as
 * far as can be told without asking the radio anything: it was read from a simulated
 * radio and this one is real, or the device's USB serial number is not the one in the
 * backup. Null when nothing speaks against it. A C62 only says who it is when asked, so
 * `flashDevice` checks its chip ID in the run that writes.
 */
export function restoreRefusal(origin: BackupOrigin, picked: PickedDevice): string | null {
  if (origin.simulated && !isSimulated(picked.device)) return SIMULATED_BACKUP;
  if (origin.idKind !== 'usb-serial' || !origin.radioId || picked.api !== 'usb') return null;
  const serial = usbSerial(picked.device);
  if (serial === null || serial === origin.radioId) return null;
  return (
    `This backup is of another radio (ID ending ${origin.radioId.slice(-8)}); the one connected ends ` +
    `${serial.slice(-8)}. Nothing was sent to it.`
  );
}

/**
 * Writes `firmware` to the picked device with the flasher for `radio`. `also` holds the
 * other images of the build that the radio needs (`Radio.alsoWrites`); they are written
 * first, in the same run.
 *
 * `restore` is given for the image out of a backup made by this page: a raw image of the
 * whole flash, not a firmware build. It is what the backup says about the radio it came
 * from (its manifest). A backup belongs to one radio, so where the radio can say who it
 * is, it is asked first: the USB serial number of an STM32 radio, the chip ID of a C62.
 * When that is not the radio in the backup, or the backup is of a simulated radio and
 * this one is real, a WrongRadioError is thrown and nothing is written.
 */
export async function flashDevice(
  radio: Radio,
  picked: PickedDevice,
  firmware: Uint8Array,
  ctx: FlashContext,
  restore: BackupOrigin | null = null,
  also: Segment[] = [],
): Promise<void> {
  const refusal = restore && restoreRefusal(restore, picked);
  if (refusal) throw new WrongRadioError(refusal);
  switch (radio.method) {
    case 'tyt-dfu':
      return flashTyt(picked.device as USBDevice, firmware, ctx);
    case 'stm32-dfu': {
      const segments = restore
        ? [rawSegment(STM32_FLASH_BASE, firmware)]
        : radio.ext === 'dfu'
          ? parseDfuFile(firmware)
          : [rawSegment(radio.address ?? STM32_FLASH_BASE, firmware)];
      return flashDfuSe(picked.device as USBDevice, segments, ctx, { chip: radio.chip });
    }
    case 'cs7000-robot': {
      if (restore) throw new FlashError('A backup cannot be written in this flashing mode.');
      const segments = parseDfuFile(firmware);
      if (segments.length !== 1 || segments[0].address !== SECOND_SLOT) {
        throw new FlashError(
          "This firmware is not built for the radio's second firmware slot, where OpenRTX goes. " +
            'Nothing was sent to the radio.',
        );
      }
      return flashCs7000Robot(picked.device as USBDevice, segments[0].data, ctx);
    }
    case 'gd77-hid':
      return flashGd77(picked.device as HIDDevice, firmware, radio.hidModel ?? 'GD-77', ctx);
    case 'rt4d-serial':
      return flashRt4d(picked.device as SerialPort, firmware, ctx);
    case 'rt950-serial':
      return flashRt950(picked.device as SerialPort, firmware, ctx);
    case 'csk-serial':
      return flashCsk(
        picked.device as SerialPort,
        [...also, { address: 0, data: firmware }],
        ctx,
        { loadModule: loadCskburn },
        // The chip's ID is the radio ID of a C62 backup.
        restore?.idKind === 'chip-id' && restore.radioId ? restore.radioId : undefined,
      );
    case 'uf2-copy':
      throw new FlashError('This radio is flashed by copying the file onto its USB drive.');
  }
}
