// SPDX-License-Identifier: GPL-3.0-or-later
/** The simulated TYT radios, for `?sim=` and the command line's `--sim`. */
import { parseTytFirmware } from '../flash/tyt.ts';
import { broken, hex, slowed } from '../sim/support.ts';
import { SimTytStock } from '../sim/tyt-stock.ts';
import { SimTytRadio, TYT_ORIGINAL_NAMES } from '../sim/tyt.ts';
import { verifyDfu } from './stm32-dfu.sim.ts';
import type { Simulator } from './types.ts';

/** The bootloader for flashing; for a backup, the radio running TYT's firmware. */
export const tytDfuSim: Simulator<USBDevice> = {
  make: ({ purpose, fail, wrongMode, delay }) => {
    if (purpose === 'backup') {
      const sim = slowed(new SimTytStock({ mode: wrongMode ? 'bootloader' : 'original' }), delay);
      return {
        device: fail ? broken(sim) : sim,
        stockProbe: {
          id: hex(sim.uid),
          forbidden: () => [...sim.forbidden],
          region: (kind, address, size) =>
            kind === 'spi-flash'
              ? sim.spi.slice(address, address + size)
              : sim.flash.slice(address - 0x08000000, address - 0x08000000 + size),
          // Program mode (91 01) is what the long read needs; a radio that was only identified never gets it.
          reads: () => sim.commands.filter((command) => command.startsWith('91 01')).length,
        },
      };
    }
    const sim = slowed(new SimTytRadio(wrongMode ? { alternateNames: TYT_ORIGINAL_NAMES } : {}), delay);
    return {
      device: fail ? broken(sim) : sim,
      sleep: sim.sleep,
      probe: { verify: (fw) => verifyDfu(sim, parseTytFirmware(fw).segments) },
    };
  },
};
