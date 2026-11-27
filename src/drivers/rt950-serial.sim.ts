// SPDX-License-Identifier: GPL-3.0-or-later
/** The simulated RT-950 Pro, for `?sim=` and the command line's `--sim`. */
import { SimRt950Stock } from '../sim/rt950-stock.ts';
import { SimRt950 } from '../sim/rt950.ts';
import { broken, same } from '../sim/support.ts';
import type { Simulator } from './types.ts';

/** The bootloader for flashing; for a backup, the radio running Radtel's firmware. */
export const rt950SerialSim: Simulator<SerialPort> = {
  make: ({ purpose, fail, wrongMode }) => {
    if (purpose === 'backup') {
      // In flashing mode the bootloader does not know the programming handshake.
      const sim = new SimRt950Stock({ mode: fail || wrongMode ? 'silent' : 'stock' });
      return {
        device: sim,
        stockProbe: {
          id: null,
          forbidden: () => [...sim.forbidden],
          region: (_kind, address, size) => sim.flash.slice(address, address + size),
          reads: () => sim.reads.length,
        },
      };
    }
    const sim = new SimRt950(fail ? { silent: true } : {});
    return {
      device: fail ? broken(sim) : sim,
      probe: {
        verify: (fw) => {
          const problems = [...sim.errors];
          if (!sim.complete) problems.push('the update did not finish');
          if (!same(sim.received.subarray(0, fw.length), fw))
            problems.push('received file differs from the firmware');
          return problems;
        },
      },
    };
  },
};
