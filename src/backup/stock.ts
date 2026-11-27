// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Reads a radio through its original firmware, in normal mode: the route for the
 * radios whose bootloader cannot be read. One reader per family; the radio's driver
 * (src/drivers/) knows which.
 */
import { driverFor, forDevice } from '../drivers/index.ts';
import { FlashError, type FlashContext } from '../flash/types.ts';
import type { Radio } from '../radios.ts';
import type { AlreadyBackedUp, Known, RadioBackup } from './types.ts';

/** The device objects a reader may be handed. */
export type StockDevice = USBDevice | SerialPort | HIDDevice;

/**
 * Reads `radio` through its original firmware: everything the reader can get. Every
 * reader only reads. `known` lets a
 * reader stop once it has recognised a radio that is already backed up; the GD-77 family
 * learns its ID only at the end of its short read, so it never stops early. The caller
 * decides whether a radio's ID is good enough to stop on (`idIsPerUnit`), and leaves
 * `known` out when it is not.
 */
export async function readStock(
  radio: Radio,
  device: StockDevice,
  ctx: FlashContext,
  known?: Known,
): Promise<RadioBackup | AlreadyBackedUp> {
  const driver = driverFor(radio);
  const backup = driver.backup(radio);
  const reader = driver.api === null ? null : forDevice(driver);
  if (!reader?.read || backup.how !== 'read' || backup.mode !== 'normal') {
    throw new FlashError(`The ${radio.name} is not backed up through its original firmware.`);
  }
  return reader.read(device, { radio, ctx, known });
}
