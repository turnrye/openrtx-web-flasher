// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What a backup of a radio is made of, whichever way it was read: in flashing mode
 * (C62, STM32 DFU) or from the original firmware running normally (TYT, GD-77, RT-4D).
 */

/** What a part of a backup holds. */
export type PartKind =
  /** The MCU's program memory, or the start of it. */
  | 'internal-flash'
  /** The external memory chip: codeplug, settings, resources, on some radios calibration. */
  | 'spi-flash'
  /** The external EEPROM of the GD-77 family. */
  | 'eeprom'
  /** Factory data blocks the firmware reports: version, serial, calibration as loaded. */
  | 'info';

/** One contiguous piece that was read. */
export interface BackupPart {
  /** File name inside the bundle, e.g. "spi-flash.bin" or "info-07.bin". */
  file: string;
  kind: PartKind;
  /** Where the piece starts in that memory, when that means something. */
  address?: number;
  data: Uint8Array;
  /** False when the read stopped early or the radio gave less than was asked. */
  complete: boolean;
  /** Anything a person reading the bundle later should know about this part. */
  note?: string;
}

/** How a radio was told apart from others of its model. */
export type IdKind =
  /** The CSK6 chip's eFuse ID. */
  | 'chip-id'
  /** The MCU's unique ID as the firmware reports it. */
  | 'uid'
  /** The serial number in the USB descriptor (STM32 ROM bootloader: derived from the MCU's unique ID). */
  | 'usb-serial'
  /** No ID can be read: a checksum of the radio's factory calibration stands in. */
  | 'fingerprint';

/** The result of reading a radio. */
export interface RadioBackup {
  /** Identifies this unit, or null when nothing could be read that does. */
  radioId: string | null;
  idKind: IdKind | null;
  /** Firmware version the radio reported, when it does. */
  firmware?: string;
  parts: BackupPart[];
  /** Things worth telling the user, e.g. "the radio gave only the first megabyte". */
  notes: string[];
  /** True when what was read is a simulated radio, not a real one. */
  simulated?: boolean;
}

/** Total bytes in a backup's parts. */
export function backupSize(backup: RadioBackup): number {
  return backup.parts.reduce((sum, part) => sum + part.data.length, 0);
}

/**
 * Asked by a reader as soon as it knows which radio it is talking to. True means a
 * backup of that radio already exists, and the reader stops there without reading the
 * rest.
 */
export type Known = (radioId: string) => boolean;

/** What a read gives when it stopped because the radio is already backed up. */
export interface AlreadyBackedUp {
  /** The ID of the radio that was recognised. */
  known: string;
}

/** True when a read stopped early because the radio was recognised. */
export function isAlready(result: RadioBackup | AlreadyBackedUp): result is AlreadyBackedUp {
  return 'known' in result;
}
