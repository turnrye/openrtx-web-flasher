// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Connect Systems bootloader of the CS7000-M17 Plus in robot mode. The radio is a
 * USB drive then, so only the command line reaches it (`Radio.commandLine`).
 */
import { flashCs7000Robot, SECOND_SLOT } from '../flash/cs7000-robot.ts';
import { parseDfuFile } from '../flash/stm32dfu.ts';
import { FlashError } from '../flash/types.ts';
import type { UsbDriver } from './types.ts';

/** The robot mode driver. It writes the second firmware slot and cannot read. */
export const cs7000Robot: UsbDriver = {
  api: 'usb',
  filters: [{ vendorId: 0x0483, productId: 0x5720 }],
  massStorage: true,
  backup: () => ({
    how: 'none',
    text: 'A radio with its Connect Systems firmware cannot be backed up: that firmware read-protects the chip, and the flashing mode has no way to read. Flashing OpenRTX leaves the bootloader and the DMR firmware in place, and Connect Systems publishes both. The 32 MB memory chip, which holds the factory calibration, cannot be read either, and OpenRTX erases a part of that chip for its own settings the first time it starts.',
  }),
  flash: async (dev, { firmware, ctx, restore }) => {
    if (restore) throw new FlashError('A backup cannot be written in this flashing mode.');
    const segments = parseDfuFile(firmware);
    if (segments.length !== 1 || segments[0].address !== SECOND_SLOT) {
      throw new FlashError(
        "This firmware is not built for the radio's second firmware slot, where OpenRTX goes. " +
          'Nothing was sent to the radio.',
      );
    }
    return flashCs7000Robot(dev, segments[0].data, ctx);
  },
  simulator: async () => (await import('../sim/env.ts')).cs7000RobotSim,
};
