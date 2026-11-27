// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Radtel's bootloader of the RT-950 Pro over Web Serial, and the read through Radtel's
 * firmware in normal mode.
 */
import { readRt950Stock } from '../backup/rt950-stock.ts';
import { flashRt950 } from '../flash/rt950.ts';
import type { SerialDriver } from './types.ts';

/** The RT-950 Pro's driver. */
export const rt950Serial: SerialDriver = {
  api: 'serial',
  backup: () => ({
    how: 'read',
    mode: 'normal',
    time: 'under a minute',
    holds:
      'your channels and settings and the factory calibration: the first 64 KB of the 4 MB memory chip, which is as far as the programming cable reaches',
    unchecked: true,
    caveat:
      'This read has not been run on a real RT-950 Pro yet. It follows the programming protocol as others worked it out; if your radio answers differently, the page says so and saves nothing.',
    notIncluded: {
      text: "Not in the backup: the rest of the memory chip (fonts, the start-up picture) and the original firmware, because the radio's bootloader cannot be read. Download the firmware version your radio runs before you flash:",
      label: "Radtel's downloads",
      url: 'https://www.radtels.com/pages/software-download',
    },
    restorable: false,
  }),
  flash: (port, { firmware, ctx }) => flashRt950(port, firmware, ctx),
  // One size: the protocol reaches 64 KiB and that reads in seconds.
  read: (port, { ctx, known }) => readRt950Stock(port, ctx, undefined, known),
  simulator: async () => (await import('./sims.ts')).rt950SerialSim,
};
