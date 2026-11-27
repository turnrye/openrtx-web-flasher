// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The flashing methods, each with everything that depends on it: the browser API and
 * the devices to offer, what a backup is, how to flash, how to read, and its simulated
 * radios. This is the only list of methods. A new one is an entry here and its driver
 * file; a radio names its method in the catalogue (src/radios.ts) and needs nothing here.
 */
import type { WebApi } from '../devices.ts';
import type { Radio } from '../radios.ts';
import { cs7000Robot } from './cs7000-robot.ts';
import { cskSerial } from './csk-serial.ts';
import { gd77Hid } from './gd77-hid.ts';
import { rt4dSerial } from './rt4d-serial.ts';
import { rt950Serial } from './rt950-serial.ts';
import { stm32Dfu } from './stm32-dfu.ts';
import { tytDfu } from './tyt-dfu.ts';
import type { DeviceDriver, Driver, ManualDriver } from './types.ts';
import { uf2Copy } from './uf2-copy.ts';

/** Every method, by the name a radio gives in `Radio.method`. */
export const DRIVERS = {
  'tyt-dfu': tytDfu,
  'stm32-dfu': stm32Dfu,
  'cs7000-robot': cs7000Robot,
  'gd77-hid': gd77Hid,
  'rt4d-serial': rt4dSerial,
  'rt950-serial': rt950Serial,
  'csk-serial': cskSerial,
  'uf2-copy': uf2Copy,
} satisfies Record<string, Driver>;

/** The driver of `radio`'s method. */
export function driverFor(radio: Pick<Radio, 'method'>): Driver {
  return DRIVERS[radio.method];
}

/** The device objects a driver may be handed. */
export type AnyDevice = USBDevice | SerialPort | HIDDevice;

/**
 * `driver` as it is called with the device that was picked for it. The chooser is asked
 * for the driver's own kind of device (`pickDevice`), so the two always agree; the types
 * cannot follow that, and this is the one place that says so.
 */
export function forDevice(driver: Exclude<Driver, ManualDriver>): DeviceDriver<WebApi, AnyDevice> {
  return driver as DeviceDriver<WebApi, AnyDevice>;
}
