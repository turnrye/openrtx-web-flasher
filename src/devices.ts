// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Where devices come from. The page asks a DeviceEnv for a USB, serial or HID device;
 * the real one opens Chrome's device chooser, the simulated one (src/sim/env.ts) hands
 * back a simulated radio. Flashers never see the difference.
 */

import type { Radio } from './radios.ts';

/** The three browser APIs the flashers use. */
export type WebApi = 'usb' | 'serial' | 'hid';

/** Source of devices for the flashers. */
export interface DeviceEnv {
  /** True when devices are simulated and no hardware is touched. */
  readonly simulated: boolean;
  /** Whether this browser has the API. */
  supports(api: WebApi): boolean;
  /**
   * Asks for a USB device for `radio`. Must be called from a click. `purpose` says whether
   * it is wanted for flashing or for a backup, which the simulated environment needs to
   * know: for some radios those are the bootloader and the original firmware.
   */
  usb(filters: USBDeviceFilter[], radio: Radio, purpose: 'flash' | 'backup'): Promise<USBDevice>;
  /** Asks for a serial port for `radio`. Must be called from a click. */
  serial(radio: Radio, purpose: 'flash' | 'backup'): Promise<SerialPort>;
  /** Asks for a HID device for `radio`. Must be called from a click. */
  hid(filters: HIDDeviceFilter[], radio: Radio, purpose: 'flash' | 'backup'): Promise<HIDDevice>;
  /** How much of `radio` to read for a backup, when it is not the radio's real size (simulated radios are small). */
  backupSize?(radio: Radio): number | undefined;
  /** Waits `ms` milliseconds; the simulated environment shortens the wait. */
  sleep(ms: number): Promise<void>;
}

/** The device objects that stand for simulated radios. */
const simulatedDevices = new WeakSet<object>();

/** Records that `device` is a simulated radio, and returns it. The simulated environment does this for every device it hands out. */
export function markSimulated<T extends object>(device: T): T {
  simulatedDevices.add(device);
  return device;
}

/** True when `device` came from the simulated environment: nothing done to it reaches hardware. */
export function isSimulated(device: object): boolean {
  return simulatedDevices.has(device);
}

/** Devices through Chrome's WebUSB, Web Serial and WebHID choosers. */
export function browserEnv(): DeviceEnv {
  return {
    simulated: false,
    supports: (api) => api in navigator,
    usb: (filters) => navigator.usb.requestDevice({ filters }),
    serial: () => navigator.serial.requestPort(),
    hid: async (filters) => {
      const [device] = await navigator.hid.requestDevice({ filters });
      if (!device) throw new DOMException('No device selected.', 'NotFoundError');
      return device;
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** True when the error means the user closed the device chooser without picking. */
export function isChooserCancel(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'AbortError');
}
