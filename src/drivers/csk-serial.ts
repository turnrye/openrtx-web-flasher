// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The CSK6's burn mode over Web Serial (Retevis C62 / C2), spoken by cskburn: flashing,
 * and the read of the whole flash in flashing mode.
 */
import { siteUrl } from '../base.ts';
import { backupCsk, flashCsk, type CskModuleLoader } from '../flash/csk.ts';
import type { SerialDriver } from './types.ts';

/** The CSK6's flash size on the C62 and C2. */
const C62_FLASH_SIZE = 4 * 1024 * 1024;

/** How much of the simulated C62 a backup reads: the real 4 MiB would take minutes. */
export const SIM_CSK_BACKUP = 64 * 1024;

/** Loads the cskburn WebAssembly module that ships next to the page. */
let loadCskburn: CskModuleLoader = async () => {
  const url = siteUrl('cskburn/cskburn.mjs');
  const module = (await import(/* @vite-ignore */ url)) as { default: Awaited<ReturnType<CskModuleLoader>> };
  return module.default;
};

/** Replaces where cskburn comes from. The command line has no page to load it next to, so it brings its own. */
export function setCskburnLoader(loader: CskModuleLoader): void {
  loadCskburn = loader;
}

/** The C62's driver. `Radio.alsoWrites` names the images written beside the firmware. */
export const cskSerial: SerialDriver = {
  api: 'serial',
  cskburn: true,
  simBackupSize: SIM_CSK_BACKUP,
  // The chip's eFuse ID.
  idIsPerUnit: () => true,
  backup: () => ({
    how: 'read',
    mode: 'flashing',
    time: 'about ten minutes',
    holds: 'the whole flash: firmware, calibration, channels and settings',
    endsFlashingMode: true,
    restorable: true,
    command: 'cskburn -C 6 -b 115200 -s <serial port> --chip-id --verify-all --read 0x0:0x400000:backup.bin',
  }),
  flash: (port, { firmware, ctx, restore, also }) =>
    flashCsk(
      port,
      [...also, { address: 0, data: firmware }],
      ctx,
      { loadModule: loadCskburn },
      // The chip's ID is the radio ID of a C62 backup.
      restore?.idKind === 'chip-id' && restore.radioId ? restore.radioId : undefined,
    ),
  read: async (port, { ctx, size, known }) => {
    const read = await backupCsk(port, size ?? C62_FLASH_SIZE, ctx, { loadModule: loadCskburn }, known);
    if ('known' in read) return read;
    const { data, chipId } = read;
    const whole = data.length === C62_FLASH_SIZE;
    return {
      radioId: chipId,
      idKind: chipId ? 'chip-id' : null,
      notes: ['cskburn checked what it read against a checksum the chip computed.'],
      parts: [
        {
          file: 'flash.bin',
          kind: 'internal-flash',
          address: 0,
          data,
          // A shorter read (only ever asked for by the simulator) can still be written back.
          complete: true,
          note: whole ? undefined : `The first ${data.length} bytes of the flash only.`,
        },
      ],
    };
  },
  simulator: async () => (await import('../sim/env.ts')).cskSerialSim,
};
