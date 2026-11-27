// SPDX-License-Identifier: GPL-3.0-or-later
/** The simulated GD-77 and DM-1801, for `?sim=` and the command line's `--sim`. */
import { parseSgl } from '../flash/gd77.ts';
import { SimGd77Stock } from '../sim/gd77-stock.ts';
import { SimGd77 } from '../sim/gd77.ts';
import { broken, same } from '../sim/support.ts';
import type { Simulator } from './types.ts';

/** The bootloader for flashing; for a backup, the radio running its original firmware. */
export const gd77HidSim: Simulator<HIDDevice> = {
  make: ({ radio, purpose, fail, wrongMode }) => {
    if (purpose === 'backup') {
      const sim = new SimGd77Stock({
        model: radio.hidModel === 'DM-1801' ? 'DM-1801' : 'GD-77',
        ...(wrongMode ? { bootloader: 'reply' as const } : {}),
      });
      return {
        device: fail ? broken(sim) : sim,
        stockProbe: {
          id: null,
          forbidden: () => [...sim.forbidden],
          region: (_kind, address, size) => sim.memory(address, address + size),
        },
      };
    }
    const sim = new SimGd77({ model: radio.hidModel ?? 'GD-77' });
    return {
      device: fail ? broken(sim) : sim,
      probe: {
        verify: (fw) => {
          const problems = [...sim.errors];
          if (!sim.complete) problems.push('the transfer did not finish');
          if (!same(sim.payload, parseSgl(fw).payload))
            problems.push('received payload differs from the firmware');
          return problems;
        },
      },
    };
  },
};
