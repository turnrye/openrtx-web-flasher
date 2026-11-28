// SPDX-License-Identifier: GPL-3.0-or-later
/** The page's simulated radios (`?sim=`), for the command line's --sim. */
import type { BundleSource } from '../src/backup/bundle.ts';
import { same } from '../src/bytes.ts';
import type { RadioBackup } from '../src/backup/types.ts';
import type { DeviceEnv } from '../src/devices.ts';
import type { Segment } from '../src/flash/types.ts';
import { simulatedEnv, type SimProbe, type SimStockProbe } from '../src/sim/env.ts';

/** What the simulated radios leave behind so that their contents can be checked afterwards. */
export interface SimProbes {
  /** The last radio handed out for flashing or for a flashing-mode backup. */
  __ortxSim?: SimProbe;
  /** The last radio handed out to be read through its original firmware. */
  __ortxSimStock?: SimStockProbe;
}

/**
 * What is wrong with the simulated radio after `data` was flashed and `also` written
 * beside it; empty when it holds exactly that. `restore` is true for a backup's image.
 */
export function flashProblems(
  probes: SimProbes,
  data: Uint8Array,
  restore: boolean,
  also: Segment[],
): string[] {
  const probe = probes.__ortxSim;
  if (!probe) return ['the simulated radio cannot be asked what it holds'];
  const problems = probe.verify(data, restore);
  for (const segment of also) {
    if (!same(segment.data, probe.read?.(segment.address, segment.data.length))) {
      problems.push(`flash at 0x${segment.address.toString(16)} differs from the image written there`);
    }
  }
  return problems;
}

/**
 * What is wrong with a backup of the simulated radio; empty when every part is what the
 * radio holds and, for a radio read through its original firmware, nothing was sent
 * that could have changed it.
 */
export function backupProblems(probes: SimProbes, source: BundleSource, backup: RadioBackup): string[] {
  if (source === 'flashing-mode') {
    const image = backup.parts.find((part) => part.kind === 'internal-flash');
    return image && same(image.data, probes.__ortxSim?.original)
      ? []
      : ['the backup differs from what the simulated radio held'];
  }
  const probe = probes.__ortxSimStock;
  if (!probe) return ['the simulated radio cannot be asked what it holds'];
  const problems = probe.forbidden().map((request) => `the reader sent ${request}, which is not a read`);
  for (const part of backup.parts) {
    if (part.kind === 'info') continue;
    if (!same(part.data, probe.region(part.kind, part.address ?? 0, part.data.length))) {
      problems.push(`${part.file} differs from what the simulated radio holds`);
    }
  }
  return problems;
}

/**
 * The simulated environment of the page in mode `mode`, and the probes of the radios it
 * hands out. The simulators leave their probes on `window`, which Node does not have, so
 * each request gets one for as long as it lasts. It must not stay: the cskburn module
 * takes a `window` to mean it runs in a browser.
 */
export function simDevices(mode: string): { env: DeviceEnv; probes: SimProbes } {
  const probes: SimProbes = {};
  const env = simulatedEnv(mode);
  const scope = globalThis as { window?: unknown };
  /** Runs one device request with `window` standing for the probes. */
  const lend = async <T>(request: () => Promise<T>): Promise<T> => {
    scope.window = probes;
    try {
      return await request();
    } finally {
      delete scope.window;
    }
  };
  return {
    probes,
    env: {
      ...env,
      usb: (...args) => lend(() => env.usb(...args)),
      serial: (...args) => lend(() => env.serial(...args)),
      hid: (...args) => lend(() => env.hid(...args)),
    },
  };
}
