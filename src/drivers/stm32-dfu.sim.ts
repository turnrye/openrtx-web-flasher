// SPDX-License-Identifier: GPL-3.0-or-later
/** The simulated STM32 radio in DFU mode, for `?sim=` and the command line's `--sim`. */
import { same } from '../bytes.ts';
import type { Segment } from '../flash/types.ts';
import { SimStm32Dfu } from '../sim/stm32dfu.ts';
import { broken, oldFirmware, slowed } from '../sim/support.ts';
import { STM32_FLASH_BASE, stm32Segments } from './stm32-dfu.ts';
import type { Simulator } from './types.ts';

/** Checks that every segment is in a DFU simulator's flash and it saw no protocol mistakes. */
export function verifyDfu(sim: SimStm32Dfu, segments: Segment[]): string[] {
  const problems = [...sim.violations];
  for (const s of segments) {
    if (!same(sim.read(s.address, s.data.length), s.data)) {
      problems.push(`flash at 0x${s.address.toString(16)} differs from the firmware`);
    }
  }
  return problems;
}

/** One radio for flashing and for the backup: both happen in DFU mode. */
export const stm32DfuSim: Simulator<USBDevice> = {
  make: ({ radio, fail, readProtected, delay }) => {
    const sim = slowed(new SimStm32Dfu({ chip: radio.chip ?? 'f405', readProtected }), delay);
    sim.load(STM32_FLASH_BASE, oldFirmware(300 * 1024));
    return {
      device: fail ? broken(sim) : sim,
      sleep: sim.sleep,
      probe: {
        verify: (fw, restore = false) => verifyDfu(sim, stm32Segments(radio, fw, restore)),
        original: sim.flash.slice(),
      },
    };
  },
};
