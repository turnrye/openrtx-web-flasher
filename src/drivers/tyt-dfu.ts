// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The TYT bootloader over WebUSB (MD-380, MD-UV380, MD-9600, DM-1701), and the read
 * through TYT's firmware in normal mode.
 */
import { readTytStock, TYT_STOCK_PLANS, type TytStockModel, type TytStockPlan } from '../backup/tyt-stock.ts';
import { flashTyt } from '../flash/tyt.ts';
import { COVERAGE_DOC, DFU_FILTERS } from './shared.ts';
import type { UsbDriver } from './types.ts';

/** The reader's plan for a radio, by its id; undefined for a radio the reader has none for. */
function planFor(id: string): TytStockPlan | undefined {
  const plans: Partial<Record<string, TytStockPlan>> = TYT_STOCK_PLANS;
  return plans[id];
}

/** The TYT family's driver. The reader has one plan per radio id (`TYT_STOCK_PLANS`). */
export const tytDfu: UsbDriver = {
  api: 'usb',
  filters: DFU_FILTERS,
  // The MCU's unique ID, as the firmware reports it.
  idIsPerUnit: () => true,
  backup: (radio) => ({
    how: 'read',
    mode: 'normal',
    time: 'up to six minutes',
    holds:
      'the factory info blocks, the first 64 KB of the program memory (the bootloader; 4 KB on Linux) and the whole 16 MB memory chip with your channels and settings',
    after: 'The radio restarts by itself when the read is done.',
    unchecked: true,
    // The reader's plan says whether its requests were measured on this model. Only the
    // MD-9600's were, which is why the first text names it.
    caveat: planFor(radio.id)?.checked
      ? 'What an MD-9600 answers to this read was measured with other tools. The read from this page has not been run on a real radio yet. Keep a codeplug read with the programming software as well.'
      : 'This read has been measured on the MD-9600 only, and with other tools. This model may give less; whatever it gives is kept, and the backup says what is missing. Keep a codeplug read with the programming software as well.',
    notIncluded: {
      text: "Not in the backup: the radio's firmware (the other 960 KB of the program memory) and the factory calibration as it is stored, in the memory chip's security registers. The backup has the firmware's own copy of the calibration. See",
      ...COVERAGE_DOC,
    },
    restorable: false,
  }),
  flash: (dev, { firmware, ctx }) => flashTyt(dev, firmware, ctx),
  read: (dev, { radio, ctx, known }) => readTytStock(dev, radio.id as TytStockModel, ctx, known),
  simulator: async () => (await import('../sim/env.ts')).tytDfuSim,
};
