// SPDX-License-Identifier: GPL-3.0-or-later
/** The simulated RT-4D, for `?sim=` and the command line's `--sim`. */
import { same } from '../bytes.ts';
import { SimRt4dStock } from '../sim/rt4d-stock.ts';
import { SimRt4d } from '../sim/rt4d.ts';
import { broken } from '../sim/support.ts';
import type { Simulator } from './types.ts';

/** The bootloader for flashing; for a backup, the radio running its original firmware. */
export const rt4dSerialSim: Simulator<SerialPort> = {
  make: ({ purpose, fail, wrongMode }) => {
    if (purpose === 'backup') {
      // A radio that does not answer is silent on an open port; the port itself opens.
      const sim = new SimRt4dStock({ mode: fail ? 'silent' : wrongMode ? 'bootloader' : 'stock' });
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
    const sim = new SimRt4d(fail ? { silent: true } : {});
    return {
      device: fail ? broken(sim) : sim,
      probe: {
        verify: (fw) => {
          const problems = [...sim.errors];
          if (!sim.complete) problems.push('not every block was written');
          if (!same(sim.flash.subarray(0, fw.length), fw)) problems.push('flash differs from the firmware');
          return problems;
        },
      },
    };
  },
};
