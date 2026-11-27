// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The NXP MK22 bootloader of the GD-77 family over WebHID, and the read through the
 * original firmware in normal mode.
 */
import { readGd77Stock } from '../backup/gd77-stock.ts';
import { flashGd77, GD77_HID_FILTER } from '../flash/gd77.ts';
import { COVERAGE_DOC } from './shared.ts';
import type { HidDriver } from './types.ts';

/** The GD-77 family's driver. `Radio.hidModel` says which of the two models it is. */
export const gd77Hid: HidDriver = {
  api: 'hid',
  filters: [GD77_HID_FILTER],
  backup: () => ({
    how: 'read',
    mode: 'normal',
    time: 'about a minute',
    holds:
      'your channels and settings (most of the 64 KB EEPROM and about 60 KB of the memory chip) and, where the firmware allows it, the factory calibration',
    unchecked: true,
    caveat:
      'Not every firmware version lets the calibration be read this way. The backup says if it could not. This read has not been run on a real radio from this page yet.',
    notIncluded: {
      text: "Not in the backup: the radio's firmware (the program memory is not read at all) and the rest of the 1 MB memory chip. See",
      ...COVERAGE_DOC,
    },
    restorable: false,
  }),
  flash: (dev, { radio, firmware, ctx }) => flashGd77(dev, firmware, radio.hidModel ?? 'GD-77', ctx),
  // The fingerprint that stands for an ID only comes at the end of the short read, so
  // `known` is never asked.
  read: (dev, { radio, scope, ctx }) =>
    readGd77Stock(dev, radio.hidModel === 'DM-1801' ? 'DM-1801' : 'GD-77', scope, ctx),
  simulator: async () => (await import('./sims.ts')).gd77HidSim,
};
