// SPDX-License-Identifier: GPL-3.0-or-later
/** The RT-4D's bootloader over Web Serial, and the read through the original firmware in normal mode. */
import { readRt4dStock } from '../backup/rt4d-stock.ts';
import { flashRt4d } from '../flash/rt4d.ts';
import { COVERAGE_DOC } from './shared.ts';
import type { SerialDriver } from './types.ts';

/** The RT-4D's driver. */
export const rt4dSerial: SerialDriver = {
  api: 'serial',
  backup: () => ({
    how: 'read',
    mode: 'normal',
    time: 'about half an hour',
    holds:
      'the whole 16 MB memory chip: calibration, settings, channels, zones, contacts, the logo, fonts, voices and the address book',
    unchecked: true,
    caveat:
      'This read has not been run on a real RT-4D yet. Other tools read the first 4 MB this way; if your radio does not give the rest, the backup keeps what was read and says so.',
    notIncluded: {
      text: "Not in the backup: the radio's firmware. The program memory (256 KB) cannot be read. See",
      ...COVERAGE_DOC,
    },
    restorable: false,
  }),
  flash: (port, { firmware, ctx }) => flashRt4d(port, firmware, ctx),
  read: (port, { ctx, known }) => readRt4dStock(port, ctx, undefined, known),
  simulator: async () => (await import('./sims.ts')).rt4dSerialSim,
};
