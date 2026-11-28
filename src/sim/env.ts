// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Simulated devices for the page (`?sim=1`). Each "device chooser" hands back a
 * simulated radio of the kind being flashed, so the whole flow can be tried, shown and
 * tested without hardware. `?sim=fail` gives radios that do not answer, `?sim=protected`
 * STM32 radios whose flash cannot be read out, `?sim=wrongmode` radios in the wrong state
 * for what is asked of them: in flashing mode for a backup that needs the original
 * firmware, in normal mode for flashing. `?sim=slow` gives USB radios and the C62
 * that take a few milliseconds over every request, so a read or a flash lasts long
 * enough to watch.
 *
 * A device asked for with purpose 'backup' is, for the radios read through their
 * original firmware, a simulated radio in normal mode. Which simulated radio a method
 * has for which purpose is its driver's to say (src/drivers/<method>.sim.ts).
 *
 * This module is all the simulator code there is to load, and nothing loads it unless
 * asked: the page for `?sim=`, a driver for its simulated radios. So every method's
 * simulators are handed on from here, and the page of someone flashing a real radio
 * downloads none of it.
 *
 * The last simulated radio is reachable as `window.__ortxSim`, so a browser test can ask
 * it whether it really holds the firmware that was flashed.
 */
import { markSimulated, type DeviceEnv } from '../devices.ts';
import { driverFor } from '../drivers/index.ts';
import type { Purpose } from '../flash/run.ts';
import { FlashError } from '../flash/types.ts';
import type { Radio } from '../radios.ts';

export { cs7000RobotSim } from '../drivers/cs7000-robot.sim.ts';
export { cskSerialSim } from '../drivers/csk-serial.sim.ts';
export { gd77HidSim } from '../drivers/gd77-hid.sim.ts';
export { rt4dSerialSim } from '../drivers/rt4d-serial.sim.ts';
export { rt950SerialSim } from '../drivers/rt950-serial.sim.ts';
export { stm32DfuSim } from '../drivers/stm32-dfu.sim.ts';
export { tytDfuSim } from '../drivers/tyt-dfu.sim.ts';

/** What a browser test can ask about the simulated radio. */
export interface SimProbe {
  /** Target name of the radio being simulated. */
  radioId: string;
  /**
   * Returns what is wrong with the radio's contents for `firmware`; empty when all is well.
   * `restore` is true when `firmware` is the image out of a backup.
   */
  verify(firmware: Uint8Array, restore?: boolean): string[];
  /** What a backup taken before any flashing should contain, for radios that can be read. */
  original?: Uint8Array;
  /** What the radio holds at an address of its flash, where the simulator can say. */
  read?(address: number, size: number): Uint8Array;
}

/** What a browser test can ask about a simulated radio that was read through its original firmware. */
export interface SimStockProbe {
  radioId: string;
  /** The ID a backup should carry, where the radio has one of its own; null where the reader derives one. */
  id: string | null;
  /** Requests that could have changed the radio. Must stay empty. */
  forbidden(): string[];
  /** What the radio holds in a memory, for comparing with a part of the backup. */
  region(kind: 'internal-flash' | 'spi-flash' | 'eeprom', address: number, size: number): Uint8Array;
  /** How many requests for memory the radio has answered, where the simulator counts them. */
  reads?(): number;
}

declare global {
  interface Window {
    __ortxSim?: SimProbe;
    __ortxSimStock?: SimStockProbe;
    /** How many times a simulated device chooser was opened. */
    __ortxSimPicks?: number;
  }
}

/** Builds the simulated environment; `mode` is the value of `?sim=`. */
export function simulatedEnv(mode: string): DeviceEnv {
  const how = {
    fail: mode === 'fail',
    wrongMode: mode === 'wrongmode',
    readProtected: mode === 'protected',
    delay: mode === 'slow' ? 4 : 0,
  };
  /** Sleep of the USB simulator in use: it keeps its own clock to check poll timing. */
  let simSleep: ((ms: number) => Promise<void>) | null = null;

  /**
   * Stands for the device chooser: makes the simulated radio that `radio`'s method has
   * for `purpose`, and leaves what a test can ask about it on `window`. The radio is of
   * the kind of device the method uses, which is the kind `pickDevice` asks for.
   */
  const pick = async <Device extends object>(radio: Radio, purpose: Purpose): Promise<Device> => {
    window.__ortxSimPicks = (window.__ortxSimPicks ?? 0) + 1;
    const driver = driverFor(radio);
    if (driver.api === null) throw new FlashError(driver.byHand);
    const made = (await driver.simulator()).make({ radio, purpose, ...how });
    simSleep = made.sleep ?? null;
    if (made.probe) window.__ortxSim = { radioId: radio.id, ...made.probe };
    if (made.stockProbe) window.__ortxSimStock = { radioId: radio.id, ...made.stockProbe };
    // Every device handed out is marked, so that a backup read from one says it came from
    // a simulated radio and is never written to a real one.
    return markSimulated(made.device as object as Device);
  };

  return {
    simulated: true,
    supports: () => true,
    sleep: (ms) => (simSleep ? simSleep(ms) : new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2)))),
    usb: (_filters, radio, purpose) => pick<USBDevice>(radio, purpose),
    hid: (_filters, radio, purpose) => pick<HIDDevice>(radio, purpose),
    serial: (radio, purpose) => pick<SerialPort>(radio, purpose),
    backupSize: (radio) => {
      const driver = driverFor(radio);
      return driver.api === null ? undefined : driver.simBackupSize;
    },
  };
}
