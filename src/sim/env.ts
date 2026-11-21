// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Simulated devices for the page (`?sim=1`). Each "device chooser" hands back a
 * simulated radio of the kind being flashed, so the whole flow can be tried, shown and
 * tested without hardware. `?sim=fail` gives radios that do not answer, `?sim=protected`
 * STM32 radios whose flash cannot be read out, `?sim=wrongmode` radios in the wrong state
 * for what is asked of them: in flashing mode for a backup that needs the original
 * firmware, in normal mode for flashing. `?sim=slow` gives USB radios and the C62
 * that take a few milliseconds over every request, so a read or a flash lasts long
 * enough to watch.
 *
 * A device asked for with purpose 'backup' is, for the radios read through their
 * original firmware, a simulated radio in normal mode.
 *
 * The last simulated radio is reachable as `window.__ortxSim`, so a browser test can ask
 * it whether it really holds the firmware that was flashed.
 */
import type { DeviceEnv } from '../devices.ts';
import { parseSgl } from '../flash/gd77.ts';
import { parseDfuFile, rawSegment } from '../flash/stm32dfu.ts';
import { parseTytFirmware } from '../flash/tyt.ts';
import type { Segment } from '../flash/types.ts';
import type { Radio } from '../radios.ts';
import { SimCsk6 } from './csk6.ts';
import { SimGd77Stock } from './gd77-stock.ts';
import { SimGd77 } from './gd77.ts';
import { md5 } from './md5.ts';
import { SimRt4dStock } from './rt4d-stock.ts';
import { SimRt4d } from './rt4d.ts';
import { SimRt950 } from './rt950.ts';
import { SimStm32Dfu } from './stm32dfu.ts';
import { SimTytStock } from './tyt-stock.ts';
import { SimTytRadio, TYT_ORIGINAL_NAMES } from './tyt.ts';

/** What a browser test can ask about the simulated radio. */
export interface SimProbe {
  /** Target name of the radio being simulated. */
  radioId: string;
  /**
   * Returns what is wrong with the radio's contents for `firmware`; empty when all is well.
   * `restore` is true when `firmware` is the image out of a backup.
   */
  verify(firmware: Uint8Array, restore?: boolean): string[];
  /** What a backup taken before any flashing should contain, for radios that can be read. */
  original?: Uint8Array;
  /** What the radio holds at an address of its flash, where the simulator can say. */
  read?(address: number, size: number): Uint8Array;
}

/** How much of the simulated C62 a backup reads: the real 4 MiB would take minutes. */
const SIM_CSK_BACKUP = 64 * 1024;

/** Recognisable "firmware the radio came with", so a backup can be checked byte for byte. */
function oldFirmware(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = 0x1234abcd;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[i] = state >>> 24;
  }
  return bytes;
}

/** What a browser test can ask about a simulated radio that was read through its original firmware. */
export interface SimStockProbe {
  radioId: string;
  /** The ID a backup should carry, where the radio has one of its own; null where the reader derives one. */
  id: string | null;
  /** Requests that could have changed the radio. Must stay empty. */
  forbidden(): string[];
  /** What the radio holds in a memory, for comparing with a part of the backup. */
  region(kind: 'internal-flash' | 'spi-flash' | 'eeprom', address: number, size: number): Uint8Array;
  /** How many requests for memory the radio has answered, where the simulator counts them. */
  reads?(): number;
}

declare global {
  interface Window {
    __ortxSim?: SimProbe;
    __ortxSimStock?: SimStockProbe;
    /** How many times a simulated device chooser was opened. */
    __ortxSimPicks?: number;
  }
}

/** Bytes as lower-case hex. */
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** True when `a` and `b` hold the same bytes. */
function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** Checks that every segment is in a DFU simulator's flash and it saw no protocol mistakes. */
function verifyDfu(sim: SimStm32Dfu, segments: Segment[]): string[] {
  const problems = [...sim.violations];
  for (const s of segments) {
    if (!same(sim.read(s.address, s.data.length), s.data)) {
      problems.push(`flash at 0x${s.address.toString(16)} differs from the firmware`);
    }
  }
  return problems;
}

/** Makes a simulated USB radio take `ms` over every control transfer; 0 leaves it as it is. */
function slowed<T extends Pick<USBDevice, 'controlTransferIn' | 'controlTransferOut'>>(
  device: T,
  ms: number,
): T {
  if (ms <= 0) return device;
  const wait = () => new Promise((resolve) => setTimeout(resolve, ms));
  const transferIn = device.controlTransferIn.bind(device);
  const transferOut = device.controlTransferOut.bind(device);
  device.controlTransferIn = async (setup, length) => {
    await wait();
    return transferIn(setup, length);
  };
  device.controlTransferOut = async (setup, data) => {
    await wait();
    return transferOut(setup, data);
  };
  return device;
}

/** Makes `device` fail to open, like a radio that is not in flashing mode. */
function broken<T extends object>(device: T): T {
  return Object.assign(device, {
    open: () => Promise.reject(new Error('The simulated radio did not answer.')),
  });
}

/** Builds the simulated environment; `mode` is the value of `?sim=`. */
export function simulatedEnv(mode: string): DeviceEnv {
  const fail = mode === 'fail';
  const wrongMode = mode === 'wrongmode';
  /** Milliseconds a slow simulated radio takes over each request. */
  const delay = mode === 'slow' ? 4 : 0;
  /** Sleep of the USB simulator in use: it keeps its own clock to check poll timing. */
  let simSleep: ((ms: number) => Promise<void>) | null = null;

  /** Counts one opening of a device chooser, for tests. */
  const picked = () => {
    window.__ortxSimPicks = (window.__ortxSimPicks ?? 0) + 1;
  };

  /** Remembers the simulated radio for tests and returns the device object. */
  const expose = <T extends object>(
    radio: Radio,
    device: T,
    verify: SimProbe['verify'],
    original?: Uint8Array,
  ): T => {
    window.__ortxSim = { radioId: radio.id, verify, original };
    return fail ? broken(device) : device;
  };

  return {
    simulated: true,
    supports: () => true,
    sleep: (ms) => (simSleep ? simSleep(ms) : new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2)))),

    usb: async (_filters, radio, purpose) => {
      picked();
      if (radio.method === 'tyt-dfu' && purpose === 'backup') {
        simSleep = null;
        const sim = slowed(new SimTytStock({ mode: wrongMode ? 'bootloader' : 'original' }), delay);
        window.__ortxSimStock = {
          radioId: radio.id,
          id: hex(sim.uid),
          forbidden: () => [...sim.forbidden],
          region: (kind, address, size) =>
            kind === 'spi-flash'
              ? sim.spi.slice(address, address + size)
              : sim.flash.slice(address - 0x08000000, address - 0x08000000 + size),
          // Program mode (91 01) is what the long read needs; a radio that was only identified never gets it.
          reads: () => sim.commands.filter((command) => command.startsWith('91 01')).length,
        };
        return fail ? broken(sim as unknown as USBDevice) : sim;
      }
      if (radio.method === 'tyt-dfu') {
        const sim = slowed(new SimTytRadio(wrongMode ? { alternateNames: TYT_ORIGINAL_NAMES } : {}), delay);
        simSleep = sim.sleep;
        return expose(radio, sim as unknown as USBDevice, (fw) =>
          verifyDfu(sim, parseTytFirmware(fw).segments),
        );
      }
      const sim = slowed(
        new SimStm32Dfu({ chip: radio.chip ?? 'f405', readProtected: mode === 'protected' }),
        delay,
      );
      sim.load(0x08000000, oldFirmware(300 * 1024));
      simSleep = sim.sleep;
      return expose(
        radio,
        sim as unknown as USBDevice,
        (fw, restore = false) =>
          verifyDfu(
            sim,
            restore
              ? [rawSegment(0x08000000, fw)]
              : radio.ext === 'dfu'
                ? parseDfuFile(fw)
                : [rawSegment(radio.address ?? 0x08000000, fw)],
          ),
        sim.flash.slice(),
      );
    },

    hid: async (_filters, radio, purpose) => {
      picked();
      simSleep = null;
      if (purpose === 'backup') {
        const sim = new SimGd77Stock({
          model: radio.hidModel === 'DM-1801' ? 'DM-1801' : 'GD-77',
          ...(wrongMode ? { bootloader: 'reply' as const } : {}),
        });
        window.__ortxSimStock = {
          radioId: radio.id,
          id: null,
          forbidden: () => [...sim.forbidden],
          region: (_kind, address, size) => sim.memory(address, address + size),
        };
        return fail ? broken(sim as unknown as HIDDevice) : sim;
      }
      const sim = new SimGd77({ model: radio.hidModel ?? 'GD-77' });
      return expose(radio, sim as unknown as HIDDevice, (fw) => {
        const problems = [...sim.errors];
        if (!sim.complete) problems.push('the transfer did not finish');
        if (!same(sim.payload, parseSgl(fw).payload))
          problems.push('received payload differs from the firmware');
        return problems;
      });
    },

    serial: async (radio, purpose) => {
      picked();
      simSleep = null;
      if (radio.method === 'rt4d-serial' && purpose === 'backup') {
        const sim = new SimRt4dStock({ mode: fail ? 'silent' : wrongMode ? 'bootloader' : 'stock' });
        window.__ortxSimStock = {
          radioId: radio.id,
          id: null,
          forbidden: () => [...sim.forbidden],
          region: (_kind, address, size) => sim.flash.slice(address, address + size),
          reads: () => sim.reads.length,
        };
        return sim;
      }
      if (radio.method === 'rt4d-serial') {
        const sim = new SimRt4d(fail ? { silent: true } : {});
        return expose(radio, sim as unknown as SerialPort, (fw) => {
          const problems = [...sim.errors];
          if (!sim.complete) problems.push('not every block was written');
          if (!same(sim.flash.subarray(0, fw.length), fw)) problems.push('flash differs from the firmware');
          return problems;
        });
      }
      if (radio.method === 'rt950-serial') {
        const sim = new SimRt950(fail ? { silent: true } : {});
        return expose(radio, sim as unknown as SerialPort, (fw) => {
          const problems = [...sim.errors];
          if (!sim.complete) problems.push('the update did not finish');
          if (!same(sim.received.subarray(0, fw.length), fw))
            problems.push('received file differs from the firmware');
          return problems;
        });
      }
      const sim = new SimCsk6({ md5, silent: fail, flashSize: 4 * 1024 * 1024, replyDelayMs: delay });
      sim.flash.set(oldFirmware(200 * 1024));
      window.__ortxSim = {
        radioId: radio.id,
        verify: (fw) =>
          same(sim.flash.subarray(0, fw.length), fw) ? [] : ['flash differs from the firmware'],
        original: sim.flash.slice(0, SIM_CSK_BACKUP),
        read: (address, size) => sim.flash.slice(address, address + size),
      };
      return sim as unknown as SerialPort;
    },

    backupSize: (radio) => (radio.method === 'csk-serial' ? SIM_CSK_BACKUP : undefined),
  };
}
