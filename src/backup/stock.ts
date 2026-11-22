// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Reads a radio through its original firmware, in normal mode: the route for the
 * radios whose bootloader cannot be read. One reader per family; this picks it.
 */
import { FlashError, type FlashContext } from '../flash/types.ts';
import type { Radio } from '../radios.ts';
import { readGd77Stock } from './gd77-stock.ts';
import { readRt4dStock } from './rt4d-stock.ts';
import { readRt950Stock } from './rt950-stock.ts';
import { readTytStock, type TytStockModel } from './tyt-stock.ts';
import type { AlreadyBackedUp, BackupScope, Known, RadioBackup } from './types.ts';

/** The device objects a reader may be handed. */
export type StockDevice = USBDevice | SerialPort | HIDDevice;

/**
 * Reads `radio` through its original firmware. Every reader only reads. `known` lets a
 * reader stop once it has recognised a radio that is already backed up; the GD-77 family
 * learns its ID only at the end of its short read, so it never stops early.
 */
export async function readStock(
  radio: Radio,
  device: StockDevice,
  scope: BackupScope,
  ctx: FlashContext,
  known?: Known,
): Promise<RadioBackup | AlreadyBackedUp> {
  switch (radio.method) {
    case 'tyt-dfu':
      return readTytStock(device as USBDevice, radio.id as TytStockModel, scope, ctx, known);
    case 'gd77-hid':
      return readGd77Stock(
        device as HIDDevice,
        radio.hidModel === 'DM-1801' ? 'DM-1801' : 'GD-77',
        scope,
        ctx,
      );
    case 'rt4d-serial':
      return readRt4dStock(device as SerialPort, scope, ctx, undefined, known);
    case 'rt950-serial':
      // One size: the protocol reaches 64 KiB and that reads in seconds.
      return readRt950Stock(device as SerialPort, ctx, undefined, known);
    default:
      throw new FlashError(`The ${radio.name} is not backed up through its original firmware.`);
  }
}
