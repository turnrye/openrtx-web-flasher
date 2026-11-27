// SPDX-License-Identifier: GPL-3.0-or-later
/** The T-TWR Plus: its bootloader is a USB drive that takes a UF2 file, which the person copies there. */
import type { ManualDriver } from './types.ts';

/** The copy-a-file driver: nothing for the page to pick, flash or read. */
export const uf2Copy: ManualDriver = {
  api: null,
  byHand: 'This radio is flashed by copying the file onto its USB drive.',
  backup: () => ({
    how: 'copy',
    text: 'The drive holds the firmware the radio runs now as CURRENT.UF2. Copy that file to your computer before you copy the new one over. It is the firmware only: the bootloader, the settings area and the rest of the 16 MB flash are not in it, and neither is the firmware of the radio module (SA868S).',
  }),
};
