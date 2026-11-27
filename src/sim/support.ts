// SPDX-License-Identifier: GPL-3.0-or-later
/** What the simulated radios of more than one method are made with (src/drivers/*.sim.ts). */

/** Recognisable "firmware the radio came with", so a backup can be checked byte for byte. */
export function oldFirmware(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = 0x1234abcd;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[i] = state >>> 24;
  }
  return bytes;
}

/** Bytes as lower-case hex. */
export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** True when `a` and `b` hold the same bytes. */
export function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** Makes a simulated USB radio take `ms` over every control transfer; 0 leaves it as it is. */
export function slowed<T extends Pick<USBDevice, 'controlTransferIn' | 'controlTransferOut'>>(
  device: T,
  ms: number,
): T {
  if (ms <= 0) return device;
  const wait = () => new Promise((resolve) => setTimeout(resolve, ms));
  const transferIn = device.controlTransferIn.bind(device);
  const transferOut = device.controlTransferOut.bind(device);
  device.controlTransferIn = async (setup, length) => {
    await wait();
    return transferIn(setup, length);
  };
  device.controlTransferOut = async (setup, data) => {
    await wait();
    return transferOut(setup, data);
  };
  return device;
}

/** Makes `device` fail to open, like a radio that is not in flashing mode. */
export function broken<T extends object>(device: T): T {
  return Object.assign(device, {
    open: () => Promise.reject(new Error('The simulated radio did not answer.')),
  });
}
