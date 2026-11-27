// SPDX-License-Identifier: GPL-3.0-or-later
/** The simulated CS7000-M17 Plus in robot mode, for the command line's `--sim`. */
import { parseDfuFile } from '../flash/stm32dfu.ts';
import { SimCs7000Robot } from '../sim/cs7000-robot.ts';
import { broken, same } from '../sim/support.ts';
import type { Simulator } from './types.ts';

/** One radio: robot mode only takes an image. */
export const cs7000RobotSim: Simulator<USBDevice> = {
  make: ({ fail }) => {
    const sim = new SimCs7000Robot({ silent: fail });
    const device = sim as unknown as USBDevice;
    return {
      device: fail ? broken(device) : device,
      probe: {
        verify: (fw) => {
          const problems = [...sim.violations];
          if (!sim.committed) problems.push('the image was not committed');
          if (!same(sim.image, parseDfuFile(fw)[0].data))
            problems.push('received image differs from the firmware');
          return problems;
        },
      },
    };
  },
};
