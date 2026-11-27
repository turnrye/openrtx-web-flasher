// SPDX-License-Identifier: GPL-3.0-or-later
/** What more than one driver uses. */
import { COVERAGE_DOC_URL } from '../coverage.ts';

/** Where the page sends people for what a backup does not hold: docs/backup-coverage.md. */
export const COVERAGE_DOC = { label: 'what each backup holds', url: COVERAGE_DOC_URL };

/** STM32 and GD32 ROM bootloaders, and the TYT bootloader that borrows ST's IDs. */
export const DFU_FILTERS: USBDeviceFilter[] = [
  { vendorId: 0x0483, productId: 0xdf11 },
  { vendorId: 0x28e9, productId: 0x0189 },
];

/** A USB device's serial number, or null when it reports none. */
export function usbSerial(dev: USBDevice): string | null {
  const serial = dev.serialNumber?.trim();
  return serial === undefined || serial === '' ? null : serial;
}
