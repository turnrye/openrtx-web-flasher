// SPDX-License-Identifier: GPL-3.0-or-later
/** The simulated C62, for `?sim=` and the command line's `--sim`. */
import { same } from '../bytes.ts';
import { SimCsk6 } from '../sim/csk6.ts';
import { md5 } from '../sim/md5.ts';
import { oldFirmware } from '../sim/support.ts';
import { SIM_CSK_BACKUP } from './csk-serial.ts';
import type { Simulator } from './types.ts';

/** One radio for flashing and for the backup: both happen in burn mode. */
export const cskSerialSim: Simulator<SerialPort> = {
  make: ({ fail, delay }) => {
    // A radio that does not answer is silent on an open port; the port itself opens.
    const sim = new SimCsk6({ md5, silent: fail, flashSize: 4 * 1024 * 1024, replyDelayMs: delay });
    sim.flash.set(oldFirmware(200 * 1024));
    return {
      device: sim as unknown as SerialPort,
      probe: {
        verify: (fw) =>
          same(sim.flash.subarray(0, fw.length), fw) ? [] : ['flash differs from the firmware'],
        original: sim.flash.slice(0, SIM_CSK_BACKUP),
        read: (address, size) => sim.flash.slice(address, address + size),
      },
    };
  },
};
