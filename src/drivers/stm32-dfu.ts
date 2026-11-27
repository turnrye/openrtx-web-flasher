// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * ST's ROM bootloader over WebUSB (Module 17, CS7000-M17, CS7000-M17 Plus): flashing, and
 * the read of the program memory in flashing mode.
 */
import { flashDfuSe, parseDfuFile, rawSegment, readDfuSe } from '../flash/stm32dfu.ts';
import type { Segment } from '../flash/types.ts';
import type { Radio } from '../radios.ts';
import { COVERAGE_DOC, DFU_FILTERS, usbSerial } from './shared.ts';
import type { UsbDriver } from './types.ts';

const MIB = 1024 * 1024;

/** Where the internal flash of the STM32 radios starts; a backup is an image of it from here. */
export const STM32_FLASH_BASE = 0x08000000;

/**
 * Where `firmware` goes on `radio`: a backup's image is the whole flash from its start,
 * a .dfu file says so itself, and a raw image goes at the radio's load address.
 */
export function stm32Segments(radio: Radio, firmware: Uint8Array, restoring: boolean): Segment[] {
  if (restoring) return [rawSegment(STM32_FLASH_BASE, firmware)];
  return radio.ext === 'dfu'
    ? parseDfuFile(firmware)
    : [rawSegment(radio.address ?? STM32_FLASH_BASE, firmware)];
}

/**
 * The STM32 DFU driver. `Radio.chip` decides the flash size, `Radio.address` where a raw
 * image goes, and `Radio.memoryChipMb` names the memory this read does not reach.
 */
export const stm32Dfu: UsbDriver = {
  api: 'usb',
  filters: DFU_FILTERS,
  // The ROM bootloader's USB serial number, which ST's bootloader derives from the MCU's
  // unique ID. For the STM32H743 it is not confirmed that it differs between radios.
  idIsPerUnit: (radio) => radio.chip !== 'h743',
  backup: (radio) => {
    const size = radio.chip === 'h743' ? 2 * MIB : MIB;
    const chip = radio.memoryChipMb;
    return {
      how: 'read',
      mode: 'flashing',
      time: 'under a minute',
      holds:
        chip === undefined
          ? 'the whole program memory: firmware, settings and calibration'
          : 'the whole program memory, bootloader included',
      unchecked: true,
      caveat: `This read has not been run on a real ${radio.name} from this page yet. A chip that is read-protected refuses it, and the page says so; nothing is changed by trying.`,
      notIncluded:
        chip === undefined
          ? undefined
          : {
              text: `Not in the backup: the ${chip} MB memory chip beside the processor, which holds the factory calibration. This page cannot read it, and OpenRTX erases a part of that chip for its own settings the first time it starts. See`,
              ...COVERAGE_DOC,
            },
      restorable: true,
      command: `dfu-util -d 0483:df11 -a 0 -s 0x08000000:${size} -U backup.bin`,
    };
  },
  flash: async (dev, { radio, firmware, ctx, restore }) =>
    flashDfuSe(dev, stm32Segments(radio, firmware, restore !== null), ctx, { chip: radio.chip }),
  read: async (dev, { radio, ctx, known }) => {
    const serial = usbSerial(dev);
    if (serial !== null && known?.(serial)) return { known: serial };
    const image = await readDfuSe(dev, ctx, { chip: radio.chip });
    return {
      radioId: usbSerial(dev),
      idKind: usbSerial(dev) ? 'usb-serial' : null,
      notes: [],
      parts: [
        {
          file: 'internal-flash.bin',
          kind: 'internal-flash',
          address: image.address,
          data: image.data,
          complete: true,
        },
      ],
    };
  },
  simulator: async () => (await import('../sim/env.ts')).stm32DfuSim,
};
