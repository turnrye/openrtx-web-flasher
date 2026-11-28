// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Picks the device for a radio and runs its backup read or its flasher. What differs
 * between flashing methods is in the method's driver (src/drivers/).
 */
import { isSimulated, type DeviceEnv } from '../devices.ts';
import { driverFor, forDevice } from '../drivers/index.ts';
import { usbSerial } from '../drivers/shared.ts';
import { readStock } from '../backup/stock.ts';
import {
  isAlready,
  type AlreadyBackedUp,
  type IdKind,
  type Known,
  type RadioBackup,
} from '../backup/types.ts';
import { backupFor, idIsPerUnit, type Radio } from '../radios.ts';
import { FlashError, WrongRadioError, type FlashContext, type Segment } from './types.ts';

export { setCskburnLoader } from '../drivers/csk-serial.ts';

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
  const driver = driverFor(radio);
  switch (driver.api) {
    case 'usb':
      return { api: 'usb', device: await env.usb(driver.filters, radio, purpose) };
    case 'hid':
      return { api: 'hid', device: await env.hid(driver.filters, radio, purpose) };
    case 'serial':
      return { api: 'serial', device: await env.serial(radio, purpose) };
    case null:
      throw new FlashError(driver.byHand);
  }
}

/**
 * Reads the radio for a backup, the way `backupFor(radio)` describes: everything the
 * page can read. `size` overrides how much of a C62 is read (the simulated one has a
 * small flash). `known` is asked as soon as the radio's ID is known; when it says the
 * radio is already backed up, nothing more is read. It is only asked where that ID is
 * known to be the radio's own (`idIsPerUnit`): any other radio is read whatever its ID,
 * and its backup carries the ID to be matched with earlier ones afterwards. A backup of a
 * simulated radio says that it is one.
 */
export async function backupDevice(
  radio: Radio,
  picked: PickedDevice,
  ctx: FlashContext,
  size?: number,
  known?: Known,
): Promise<RadioBackup | AlreadyBackedUp> {
  const read = await readDevice(radio, picked, ctx, size, idIsPerUnit(radio) ? known : undefined);
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
  if (backup.mode === 'normal') return readStock(radio, picked.device, ctx, known);
  const driver = driverFor(radio);
  const reader = driver.api === null ? null : forDevice(driver);
  if (!reader?.read) throw new FlashError('This radio cannot be read out.');
  return reader.read(picked.device, { radio, ctx, size, known });
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
  const driver = driverFor(radio);
  if (driver.api === null) throw new FlashError(driver.byHand);
  return forDevice(driver).flash(picked.device, { radio, firmware, ctx, restore, also });
}
