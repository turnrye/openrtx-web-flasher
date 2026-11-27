// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What a backup made by this tool holds of each radio, memory by memory, and what it
 * does not. Every memory that is not saved whole is a critical gap: the record says what
 * would be lost and how the gap can be closed.
 *
 * This is the one place those facts live. `backupFor` in radios.ts words the same thing
 * for the user, docs/backup-coverage.md is written from this table, and coverage.test.ts
 * fails when either disagrees with it or with the readers' own sizes.
 *
 * The hardware facts are from a backup-coverage audit of 2026-11-26 and from the sources
 * each reader names. Where nobody has confirmed one on a radio, `unverified` says so.
 */
import type { Radio } from './radios.ts';

/** Which memory of a radio. */
export type MemoryKind =
  /** The processor's own program memory. */
  | 'internal-flash'
  /** The memory chip beside the processor. */
  | 'spi-flash'
  /** A separate EEPROM. */
  | 'eeprom'
  /** Anything else that keeps data: a chip's security registers, a radio module's own memory. */
  | 'other';

/** How much of a memory a backup made by this tool holds today. */
export type Saved = 'all' | 'part' | 'none';

/** Whether this tool's read of a memory has been run on a real radio. */
export type ReadCheck =
  /** Run from this tool on a real radio, and the result compared with another tool's (docs/bench-notes.md). */
  | 'checked'
  /** The same requests were measured on a real radio of this model with another tool; never with this one. */
  | 'other-tool'
  /** Run against the simulator only. */
  | 'unchecked';

/** How a gap can be closed. */
export type Closing =
  /** Nothing is missing. */
  | { how: 'none-needed' }
  /** The route the tool already uses can read more. */
  | { how: 'read-more'; text: string }
  /** Another tool reads it today. */
  | { how: 'other-tool'; tool: string; url: string; text: string }
  /**
   * Neither the bootloader nor the original firmware gives it up: it needs a dumper, a
   * small reader firmware loaded for the occasion (docs/dumper.md).
   */
  | {
      how: 'dumper';
      /** What the dumper must do. */
      does: string;
      /** What it cannot bring back. */
      cannot?: string;
    };

/** One memory of one radio. */
export interface MemoryCoverage {
  kind: MemoryKind;
  /** What to call it, with the part where that is known. */
  name: string;
  /** Size in bytes; null where it is not known. */
  bytes: number | null;
  /** What lives there. */
  holds: string;
  saved: Saved;
  /** The range or amount that is saved, in words. */
  savedText: string;
  /** Whether that read was run on a real radio; absent when nothing is read. */
  check?: ReadCheck;
  /** What is lost if it is not saved; absent when all of it is. */
  lost?: string;
  close: Closing;
  /** A fact in this entry that nobody has confirmed on a radio. */
  unverified?: string;
}

/** Everything known about backing up one radio. */
export interface RadioCoverage {
  memories: MemoryCoverage[];
  /**
   * True when the read talks to the manufacturer's firmware, so it cannot be made once
   * the radio runs OpenRTX. See OPENRTX_LIMIT.
   */
  needsOriginalFirmware: boolean;
}

/**
 * The limit of every backup that is read in normal mode, for the page to say: there is
 * nothing to ask once OpenRTX has replaced the firmware that answered.
 */
export const OPENRTX_LIMIT =
  'A radio that already runs OpenRTX cannot be backed up this way: the read is answered by the ' +
  "manufacturer's firmware, and OpenRTX has replaced it. OpenRTX has no backup command of its own yet.";

/** Where docs/backup-coverage.md, written from this record, can be read. */
export const COVERAGE_DOC_URL =
  'https://github.com/turnrye/openrtx-web-flasher/blob/main/docs/backup-coverage.md';

const KIB = 1024;
const MIB = 1024 * KIB;

const WHOLE: Closing = { how: 'none-needed' };

const TYT_DUMPER: Closing = {
  how: 'dumper',
  does: 'Run from the first 16 KB of the firmware area (flash sector 3), which the read through the original firmware saves first, and send the rest of the program memory and the three security registers over USB.',
  cannot:
    'On Linux the first read saves 4,096 bytes, not the 65,535 that cover sector 3, so the dumper must not be loaded from Linux. The snapshot also ends one byte before the end of sector 3.',
};

/**
 * MD-380, MD-UV380, MD-9600 and DM-1701: one board family, one reader. `unverified` is
 * about the whole read and is kept with the memory chip, the bulk of it.
 */
function tyt(check: ReadCheck, unverified: string): RadioCoverage {
  return {
    needsOriginalFirmware: true,
    memories: [
      {
        kind: 'internal-flash',
        name: 'program memory (STM32F405)',
        bytes: MIB,
        holds: "TYT's bootloader (the first 48 KB) and the original firmware",
        saved: 'part',
        savedText:
          'the first 65,535 bytes: the bootloader and the first 16 KB of the firmware. On Linux 4,096 bytes, because the system caps the request',
        check,
        lost: "The original firmware as this radio had it (the other 960 KB). Flashing replaces it, and the only way back is the manufacturer's firmware file for this model and board.",
        close: TYT_DUMPER,
      },
      {
        kind: 'spi-flash',
        name: 'memory chip (W25Q128)',
        bytes: 16 * MIB,
        holds: 'channels, contacts and settings, and the fonts and other resources of the original firmware',
        saved: 'all',
        savedText: 'all 16 MiB',
        check,
        close: WHOLE,
        unverified,
      },
      {
        kind: 'other',
        name: "the memory chip's security registers",
        bytes: 3 * 256,
        holds:
          'the factory calibration as stored (512 bytes in registers 1 and 2) and the hardware option block (64 bytes in register 3)',
        saved: 'none',
        savedText:
          'nothing of the registers themselves. The backup has what the firmware reports in their place: the calibration as loaded in RAM (info block 05) and the option block (info blocks 01 and 03)',
        lost: 'The factory calibration in the form it is stored, which is not published. OpenRTX reads its calibration from these registers and does not write them.',
        close: TYT_DUMPER,
      },
    ],
  };
}

const GDX_DUMPER: Closing = {
  how: 'dumper',
  does: "A reader built from OpenRTX's drivers for these radios, loaded like firmware through the bootloader, that sends the whole EEPROM, the whole memory chip and the program memory over USB.",
  cannot:
    'The original firmware: the bootloader puts the dumper in its place. That comes back with the manufacturer’s firmware file.',
};

/**
 * GD-77 and DM-1801. `flashEnd` is where the reader stops in the programming software's
 * address space; `calibration` is where OpenRTX reads the calibration on the chip.
 */
function gdx(flashEnd: number, calibration: number): RadioCoverage {
  const flashBytes = flashEnd - 0x10000;
  return {
    needsOriginalFirmware: true,
    memories: [
      {
        kind: 'internal-flash',
        name: 'program memory (MK22FN512)',
        bytes: 512 * KIB,
        holds: 'the bootloader and the original firmware',
        saved: 'none',
        savedText: 'nothing: neither the bootloader nor the programming protocol reads it',
        lost: "The original firmware as this radio had it. Flashing replaces it, and the only way back is the manufacturer's firmware file.",
        close: GDX_DUMPER,
      },
      {
        kind: 'eeprom',
        name: 'EEPROM',
        bytes: 64 * KIB,
        holds: 'channels, zones and settings',
        saved: 'part',
        savedText: '64,384 of 65,536 bytes: programming addresses 0x0080 to 0x7BFF and 0x8000 to 0xFFFF',
        check: 'unchecked',
        lost: 'The first 128 bytes and 0x7C00 to 0x7FFF. What they hold is not known here.',
        close: GDX_DUMPER,
      },
      {
        kind: 'spi-flash',
        name: 'memory chip',
        bytes: MIB,
        holds: `the upper part of the codeplug, and the factory calibration (OpenRTX reads it at 0x${calibration.toString(16).toUpperCase()})`,
        saved: 'part',
        savedText: `${flashBytes.toLocaleString('en-US')} bytes: programming addresses 0x10000 to 0x${(flashEnd - 1).toString(16).toUpperCase()}. Also the 4 KB the firmware returns at 0x7C00, which holds the calibration on the firmware versions that answer there`,
        check: 'unchecked',
        lost: 'The rest of the chip, and with it the factory calibration, which is not published, on a radio whose firmware does not give it at 0x7C00. The backup says when it did not.',
        close: GDX_DUMPER,
        unverified: 'Where the programming addresses land on the chip.',
      },
    ],
  };
}

/** The backup coverage of every radio, by radio id. */
export const COVERAGE: Readonly<Record<string, RadioCoverage>> = {
  md3x0: tyt(
    'unchecked',
    'What the original firmware answers was measured on an MD-9600 only; this model is assumed to answer the same. Some early VHF MD-380s have a 1 MB memory chip, and what the read does past its end is not known.',
  ),
  mduv3x0: tyt(
    'unchecked',
    'What the original firmware answers was measured on an MD-9600 only; this model is assumed to answer the same.',
  ),
  md9600: tyt(
    'other-tool',
    'What the original firmware answers was measured on MD-9600s with other tools (RadioFoundry, and the maintainer’s own). This tool’s read has not been run on a radio.',
  ),
  dm1701: tyt(
    'unchecked',
    'What the original firmware answers was measured on an MD-9600 only; this model is assumed to answer the same.',
  ),
  gd77: gdx(0x1eea0, 0x8f000),
  dm1801: gdx(0x1ee80, 0x6f000),
  cs7000: {
    needsOriginalFirmware: false,
    memories: [
      {
        kind: 'internal-flash',
        name: 'program memory (STM32F405)',
        bytes: MIB,
        holds: 'the bootloader and the original firmware',
        saved: 'all',
        savedText: 'all 1 MiB, in flashing mode; the page can write it back',
        check: 'unchecked',
        close: WHOLE,
      },
      {
        kind: 'spi-flash',
        name: 'memory chip (W25Q128)',
        bytes: 16 * MIB,
        holds:
          "the factory calibration (OpenRTX reads it at 0x1000 to 0x10DC), other data from the maker, and the original firmware's channels and settings",
        saved: 'none',
        savedText: 'nothing: flashing mode reaches the program memory only',
        lost: 'The factory calibration, which is not published. OpenRTX erases 0x8000 to 0xBFFF of this chip for its own settings the first time it starts.',
        close: {
          how: 'dumper',
          does: 'A reader loaded over DFU in place of the firmware, once the program memory is saved, that sends the 16 MiB chip over USB. It must run before OpenRTX first starts.',
          cannot: 'What OpenRTX erased (0x8000 to 0xBFFF) on a radio that has already run it.',
        },
      },
    ],
  },
  cs7000p: {
    needsOriginalFirmware: false,
    memories: [
      {
        kind: 'internal-flash',
        name: 'program memory (STM32H743)',
        bytes: 2 * MIB,
        holds: 'the Connect Systems bootloader and both firmware slots',
        saved: 'part',
        savedText:
          'all 2 MiB in DFU mode, but only from a radio that lets itself be read. A radio with its Connect Systems firmware read-protects the chip and gives nothing, and robot mode (the command line) cannot read at all',
        check: 'unchecked',
        lost: 'The bootloader and DMR firmware as this radio had them. Flashing OpenRTX leaves both in place, and Connect Systems publishes both.',
        close: {
          how: 'dumper',
          does: 'A reader written to the second firmware slot in robot mode, from the command line only, that sends the memory chip and the program memory over USB.',
          cannot: 'Whatever the second slot held before.',
        },
        unverified: 'Whether code in the second slot can read the protected program memory.',
      },
      {
        kind: 'spi-flash',
        name: 'memory chip',
        bytes: 32 * MIB,
        holds:
          "the factory calibration (OpenRTX reads it at 0x1000 to 0x10DC), other data from the maker, and the original firmware's channels and settings",
        saved: 'none',
        savedText: 'nothing: neither flashing mode reaches it',
        lost: 'The factory calibration, which is not published. OpenRTX erases 0x1000000 to 0x1003FFF of this chip for its own settings the first time it starts.',
        close: {
          how: 'dumper',
          does: 'The same reader in the second firmware slot: it sends all 32 MiB over USB. It must run before OpenRTX first starts.',
          cannot: 'What OpenRTX erased (0x1000000 to 0x1003FFF) on a radio that has already run it.',
        },
      },
    ],
  },
  rt4d: {
    needsOriginalFirmware: true,
    memories: [
      {
        kind: 'internal-flash',
        name: 'program memory (AT32F423)',
        bytes: 256 * KIB,
        holds: 'the bootloader and the original firmware',
        saved: 'none',
        savedText: 'nothing: neither the bootloader nor the programming protocol reads it',
        lost: "The original firmware as this radio had it. Flashing replaces it, and the only way back is the manufacturer's firmware file.",
        close: {
          how: 'dumper',
          does: 'A reader loaded like firmware through the bootloader that sends the program memory over the programming cable.',
          cannot:
            'The original firmware: the bootloader puts the dumper in its place. Only the bootloader would be gained.',
        },
      },
      {
        kind: 'spi-flash',
        name: 'memory chip',
        bytes: 16 * MIB,
        holds:
          'calibration, settings, channels, zones, contacts, the boot logo, fonts and voices in the first 4 MiB; the address book above it',
        saved: 'all',
        savedText: 'all 16 MiB, one 1,024-byte block at a time',
        check: 'unchecked',
        close: WHOLE,
        unverified:
          'The tool this read follows stops at 4 MiB. That the original firmware also answers for the blocks above is taken from the block numbering and from open firmware for a sibling radio, not from an RT-4D. A read that stops there keeps the first 4 MiB and is marked incomplete.',
      },
    ],
  },
  rt950pro: {
    needsOriginalFirmware: true,
    memories: [
      {
        kind: 'internal-flash',
        name: 'program memory',
        bytes: MIB,
        holds:
          "Radtel's bootloader (the first 12 KiB, which flashing never writes) and the original firmware",
        saved: 'none',
        savedText: 'nothing: the bootloader cannot be read',
        lost: 'The original firmware as this radio had it. Flashing replaces it; Radtel publishes firmware files.',
        close: {
          how: 'dumper',
          does: 'A reader firmware for this radio. In progress on a branch (rt950pro-full-backup).',
          cannot:
            'The original firmware, where the reader takes its place. That comes back with Radtel’s file.',
        },
      },
      {
        kind: 'spi-flash',
        name: 'memory chip',
        bytes: 4 * MIB,
        holds:
          'channels, settings and the calibration areas in the first 64 KiB; fonts, the start-up picture and the rest above',
        saved: 'part',
        savedText: 'the first 64 KiB, which is as far as the programming protocol’s 16-bit address reaches',
        check: 'unchecked',
        lost: 'Everything above 64 KiB, which is 63/64 of the chip: fonts, the start-up picture and whatever else Radtel keeps there.',
        close: {
          how: 'dumper',
          does: 'The same reader firmware sends the whole 4 MiB. In progress on a branch (rt950pro-full-backup).',
        },
      },
    ],
  },
  mod17: {
    needsOriginalFirmware: false,
    memories: [
      {
        kind: 'internal-flash',
        name: 'program memory (STM32F405)',
        bytes: MIB,
        holds: 'the firmware, and settings and calibration in the last sector',
        saved: 'all',
        savedText: 'all 1 MiB, in flashing mode; the page can write it back',
        check: 'unchecked',
        close: WHOLE,
      },
    ],
  },
  ttwrplus: {
    needsOriginalFirmware: false,
    memories: [
      {
        kind: 'internal-flash',
        name: 'flash of the ESP32-S3',
        bytes: 16 * MIB,
        holds: 'the bootloader, the settings area (NVS), the firmware and an 11.7 MB storage area',
        saved: 'part',
        savedText:
          'the firmware only, and only if you copy CURRENT.UF2 off the drive yourself: the tool reads nothing',
        check: 'unchecked',
        lost: 'The bootloader, the settings area and the storage area as the radio came.',
        close: {
          how: 'other-tool',
          tool: 'esptool',
          url: 'https://github.com/espressif/esptool',
          text: 'In the ESP32-S3’s ROM download mode, esptool reads all 16 MB: `esptool.py read_flash 0 0x1000000 backup.bin`. The page could do the same with esptool-js; that is not built.',
        },
      },
      {
        kind: 'other',
        name: 'the radio module (SA868S)',
        bytes: null,
        holds: "the module's own firmware, which the open sa8x8 firmware replaces before OpenRTX can be used",
        saved: 'none',
        savedText: 'nothing',
        lost: "The module's original firmware.",
        close: {
          how: 'dumper',
          does: 'Not worked out: no way to read the module is known here.',
        },
        unverified: 'How much memory the module has, and whether it can be read at all.',
      },
    ],
  },
  c62: {
    needsOriginalFirmware: false,
    memories: [
      {
        kind: 'internal-flash',
        name: 'flash of the CSK6 module',
        bytes: 4 * MIB,
        holds: 'firmware, DSP image, calibration, channels and settings',
        saved: 'all',
        savedText: 'all 4 MiB, checked against an MD5 the chip computes; the page can write it back',
        check: 'checked',
        close: WHOLE,
        unverified: 'Writing a backup back from the page has not been tried on a radio.',
      },
    ],
  },
};

/**
 * The radios with a gap, worst first: by what is lost for good and how soon flashing
 * loses it. A radio whose memory chip OpenRTX writes to comes before one whose chip
 * OpenRTX leaves alone.
 */
export const WORST_FIRST: readonly string[] = [
  'cs7000',
  'cs7000p',
  'rt950pro',
  'md9600',
  'mduv3x0',
  'md3x0',
  'dm1701',
  'gd77',
  'dm1801',
  'ttwrplus',
  'rt4d',
];

/** The coverage record of `radio`. Every radio in the catalogue has one. */
export function coverageFor(radio: Pick<Radio, 'id'>): RadioCoverage {
  const coverage = COVERAGE[radio.id];
  if (!coverage) throw new Error(`No backup coverage is recorded for "${radio.id}".`);
  return coverage;
}

/** The memories of `radio` a backup does not hold whole. Each one is a critical gap. */
export function gapsFor(radio: Pick<Radio, 'id'>): MemoryCoverage[] {
  return coverageFor(radio).memories.filter((memory) => memory.saved !== 'all');
}

/** True when a backup of `radio` holds every memory the radio has. */
export function isComplete(radio: Pick<Radio, 'id'>): boolean {
  return gapsFor(radio).length === 0;
}

/** A size for people: "64 KiB", "16 MiB", "768 bytes". */
export function sizeText(bytes: number | null): string {
  if (bytes === null) return 'size not known';
  if (bytes % MIB === 0) return `${bytes / MIB} MiB`;
  if (bytes % KIB === 0) return `${bytes / KIB} KiB`;
  return `${bytes} bytes`;
}

/** The short word for how a gap can be closed. */
export function closingText(close: Closing): string {
  switch (close.how) {
    case 'none-needed':
      return 'nothing to close';
    case 'read-more':
      return 'the same read can be made to reach it';
    case 'other-tool':
      return `${close.tool} reads it`;
    case 'dumper':
      return 'needs a dumper';
  }
}

/** One gap in a line, for the command line: which memory, how much is saved, how it closes. */
export function gapLine(gap: MemoryCoverage): string {
  const saved = gap.saved === 'none' ? 'not saved' : 'saved in part';
  return `${gap.name}, ${sizeText(gap.bytes)}: ${saved}; ${closingText(gap.close)}`;
}

/** What `radio`'s backup cannot do once the radio runs OpenRTX; null when it still works. */
export function openRtxLimit(radio: Pick<Radio, 'id'>): string | null {
  return coverageFor(radio).needsOriginalFirmware ? OPENRTX_LIMIT : null;
}
