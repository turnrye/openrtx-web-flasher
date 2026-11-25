// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The radios OpenRTX builds for and how each one is flashed.
 *
 * `id` is the OpenRTX target name: CI names its files `openrtx_<id>_<version>.<ext>` and
 * its per-radio artifacts `openrtx-<id>`.
 */

/** How the bytes get into the radio. */
export type Method =
  | 'tyt-dfu'
  | 'stm32-dfu'
  | 'cs7000-robot'
  | 'gd77-hid'
  | 'rt4d-serial'
  | 'rt950-serial'
  | 'csk-serial'
  | 'uf2-copy';

/** A flash that was checked on a real radio. Empty until someone does it. */
export interface Verification {
  /** Firmware version that was flashed; left out when the report did not say. */
  version?: string;
  /** Browser and OS, e.g. "Chrome 142, macOS 26"; left out when the report did not say. */
  platform?: string;
  /** ISO date. */
  date: string;
}

/** The fallback: a tool the user runs themselves. */
export interface ManualTool {
  /** Tool name shown to the user. */
  tool: string;
  /** Command line with `{file}` for the firmware file, when there is one. */
  command?: string;
  /** Extra line for people on Windows. */
  windows?: string;
  /** Where to get the tool. */
  url: string;
}

/** A tool other than this page that flashes a radio. */
export interface OtherTool {
  tool: string;
  url: string;
  /** What it runs on and what to give it, for the user. */
  text: string;
}

/** A second image a radio needs next to its firmware file. */
export interface Companion {
  /** File name in the build. */
  file: string;
  /** Where it goes in the radio's flash. */
  address: number;
  /** What it is, for people. */
  what: string;
}

/** One supported radio. */
export interface Radio {
  id: string;
  name: string;
  /** Other names the same hardware is sold under. */
  aka?: string;
  method: Method;
  /** Extension of the file to flash in the browser. */
  ext: string;
  /** Extra file names (regex source) this radio accepts, e.g. Zephyr's zephyr.bin. */
  alsoMatches?: string;
  /** Other extensions worth offering for download (for the manual tool). */
  otherExts?: string[];
  /**
   * Files of the same build that must be written as well, each at its own address. The
   * firmware does not start without them.
   */
  alsoWrites?: Companion[];
  /** Load address for raw images sent over STM32 DFU. */
  address?: number;
  /** MCU of radios flashed over STM32 DFU, when it is not the STM32F405: decides the flash size. */
  chip?: 'f405' | 'h743';
  /** GD-77 family model string for the HID bootloader. */
  hidModel?: 'GD-77' | 'DM-1801';
  /** True when the radio's "enter" drawing (public/art/<id>-enter.svg) shows the keys to hold in gold. */
  heldKeysDrawn?: boolean;
  /** Steps that put the radio into flashing mode. */
  enter: string[];
  /** True when OpenRTX's docs do not give the key combination and `enter` is a best guess. */
  enterUnconfirmed?: boolean;
  /** What to do once flashing finished. */
  after: string;
  /** Things to know at the moment of flashing, shown next to the Flash button. */
  flashNotes?: string[];
  manual: ManualTool;
  /**
   * For a radio the page cannot flash in the state it usually comes in: why, and the
   * tools to use instead. The page says so before it asks for the radio.
   */
  useInstead?: { why: string; tools: OtherTool[] };
  /**
   * Another way into the radio that only the command line has: a kind of USB device that
   * browsers keep from web pages. The command line uses these in place of the radio's own.
   */
  commandLine?: Pick<Radio, 'method' | 'enter' | 'after' | 'flashNotes' | 'manual'>;
  /** Null until a flash through this page was checked on real hardware. */
  verified: Verification | null;
}

/** `radio` as the command line flashes it. */
export function forCommandLine(radio: Radio): Radio {
  const { commandLine, ...rest } = radio;
  return commandLine ? { ...rest, ...commandLine } : radio;
}

const RADIO_TOOL: ManualTool = {
  tool: 'radio_tool',
  command: 'radio_tool -d 0 -f -i {file}',
  windows: 'On Windows you can also use the manufacturer’s firmware upgrade tool with this file.',
  url: 'https://github.com/v0l/radio_tool',
};

const GD77_LOADER: ManualTool = {
  tool: 'gd-77_firmware_loader.py',
  command: 'python3 scripts/gd-77_firmware_loader.py -f {file} -m {model}',
  url: 'https://github.com/OpenRTX/OpenRTX/blob/master/scripts/gd-77_firmware_loader.py',
};

/** Every radio, in the order the picker shows them. */
export const RADIOS: Radio[] = [
  {
    id: 'md3x0',
    heldKeysDrawn: true,
    name: 'Tytera MD-380 / MD-390',
    aka: 'Retevis RT3 / RT8',
    method: 'tyt-dfu',
    ext: 'bin',
    enter: [
      'Turn the radio off and connect the programming cable.',
      'Hold PTT and the side button above it, then turn the radio on.',
      'The screen stays dark and the LED blinks: the radio is in flashing mode (TYT calls it firmware upgrade mode).',
    ],
    after: 'Turn the radio off and on again.',
    manual: RADIO_TOOL,
    verified: null,
  },
  {
    id: 'mduv3x0',
    heldKeysDrawn: true,
    name: 'Tytera MD-UV380 / MD-UV390',
    aka: 'Retevis RT3S',
    method: 'tyt-dfu',
    ext: 'bin',
    enter: [
      'Turn the radio off and connect the programming cable.',
      'Hold PTT and the side button above it, then turn the radio on.',
      'The screen stays dark and the LED blinks: the radio is in flashing mode (TYT calls it firmware upgrade mode).',
    ],
    after: 'Turn the radio off and on again.',
    manual: RADIO_TOOL,
    verified: null,
  },
  {
    id: 'md9600',
    heldKeysDrawn: true,
    name: 'Tytera MD-9600',
    aka: 'Retevis RT90',
    method: 'tyt-dfu',
    ext: 'bin',
    enter: [
      'Remove power and connect the programming cable.',
      'Hold the orange button and P1 (the two keys at the lower left of the front panel), then apply power.',
      'The screen blinks on and off with nothing on it: the radio is in flashing mode (TYT calls it firmware upgrade mode).',
    ],
    after: 'Remove power and apply it again.',
    manual: RADIO_TOOL,
    verified: null,
  },
  {
    id: 'dm1701',
    heldKeysDrawn: true,
    name: 'Baofeng DM-1701',
    aka: 'Retevis RT84',
    method: 'tyt-dfu',
    ext: 'bin',
    otherExts: ['wrap'],
    enter: [
      'Turn the radio off and connect the programming cable.',
      'Hold PTT and the side button above it (SK1), then turn the radio on.',
      'The screen stays dark: the radio is in flashing mode.',
    ],
    enterUnconfirmed: true,
    after: 'Turn the radio off and on again.',
    manual: RADIO_TOOL,
    verified: null,
  },
  {
    id: 'gd77',
    heldKeysDrawn: true,
    name: 'Radioddity GD-77',
    method: 'gd77-hid',
    ext: 'sgl',
    hidModel: 'GD-77',
    enter: [
      'Turn the radio off and connect the programming cable.',
      'Hold the two side buttons below PTT, then turn the radio on.',
      'The screen stays dark and the LED lights: the radio is in flashing mode.',
    ],
    after: 'Turn the radio off and on again.',
    manual: GD77_LOADER,
    verified: null,
  },
  {
    id: 'dm1801',
    heldKeysDrawn: true,
    name: 'Baofeng DM-1801',
    method: 'gd77-hid',
    ext: 'sgl',
    hidModel: 'DM-1801',
    enter: [
      'Turn the radio off and connect the programming cable.',
      'Hold the two side buttons below PTT, then turn the radio on.',
      'The screen stays dark and the LED lights: the radio is in flashing mode.',
    ],
    after: 'Turn the radio off and on again.',
    manual: GD77_LOADER,
    verified: null,
  },
  {
    id: 'cs7000',
    heldKeysDrawn: true,
    name: 'Connect Systems CS7000-M17',
    method: 'stm32-dfu',
    ext: 'dfu',
    otherExts: ['bin'],
    enter: [
      'Turn the radio off and connect the USB cable.',
      'Hold the top side key (SK1), then turn the radio on.',
      'The computer sees an “STM32 BOOTLOADER” device.',
    ],
    enterUnconfirmed: true,
    after: 'Turn the radio off and on again.',
    manual: {
      tool: 'dfu-util',
      command: 'dfu-util -d 0483:df11 -a 0 -D {file}',
      windows: 'On Windows, STM32CubeProgrammer or DfuSe Demo can write the same .dfu file.',
      url: 'https://dfu-util.sourceforge.net/',
    },
    // docs/verification.md, 2026-11-21: reported working; browser and system not recorded.
    verified: { version: 'a build of the release-v0.5.0 branch', date: '2026-11-21' },
  },
  {
    id: 'cs7000p',
    chip: 'h743',
    heldKeysDrawn: true,
    name: 'Connect Systems CS7000-M17 Plus',
    method: 'stm32-dfu',
    ext: 'dfu',
    otherExts: ['bin'],
    enter: [
      'Turn the radio off and connect the USB cable.',
      'Hold the top side key (SK1), then turn the radio on. The screen turns grey.',
      'The computer sees an “STM32 BOOTLOADER” device.',
    ],
    after:
      'Wait ten seconds, then turn the radio off. Hold SK3 while turning it on to start OpenRTX; ' +
      'without a key it starts the DMR firmware.',
    flashNotes: [
      'OpenRTX goes in the second firmware slot; the Connect Systems bootloader and DMR firmware stay.',
      'Writing takes a while and the radio shows nothing while it happens.',
      'A radio that still has its Connect Systems firmware refuses this flashing mode. Use one of the other tools below.',
    ],
    manual: {
      tool: 'Connect Systems Factory Tool',
      windows:
        'Use the .bin file with the Factory Tool (hold PTT and the orange button while turning on). ' +
        'The .dfu file works with dfu-util or DfuSe Demo in DFU mode.',
      command: 'dfu-util -d 0483:df11 -a 0 -D {file}',
      url: 'https://www.connectsystems.com/amateur-software/CS7000_m17_plus_software.html',
    },
    useInstead: {
      why:
        'A radio with its Connect Systems firmware on it, as it comes from the factory, cannot be flashed from ' +
        'a browser: that firmware locks the flashing mode a browser can use. Flash it with one of these tools ' +
        'and the .bin file of the build instead. They write OpenRTX into the second firmware slot and leave ' +
        'the Connect Systems bootloader and DMR firmware in place. The steps on this page are for a radio ' +
        'without that firmware.',
      tools: [
        {
          tool: 'Connect Systems Factory Tool',
          url: 'https://www.connectsystems.com/amateur-software/CS7000_m17_plus_software.html',
          text: 'Windows. Hold PTT and the orange button on top while turning the radio on, then load the .bin file.',
        },
        {
          tool: 'cs7000plus_flasher by imostlylurk',
          url: 'https://github.com/imostlylurk/cs7000plus_flasher',
          text: 'Linux. The same flashing mode; give it the .bin file.',
        },
      ],
    },
    commandLine: {
      method: 'cs7000-robot',
      enter: [
        'Turn the radio off and connect the USB cable.',
        'Hold PTT and the orange button on top, then turn the radio on.',
        'The LED changes colour in a loop: the radio is in flashing mode (Connect Systems calls it robot mode).',
      ],
      after:
        'Turn the radio off. Hold SK3 while turning it on to start OpenRTX; without a key it starts the DMR firmware.',
      flashNotes: [
        'OpenRTX goes in the second firmware slot; the Connect Systems bootloader and DMR firmware stay.',
        'The radio cannot be read in this mode, so what was written is not compared afterwards.',
      ],
      manual: {
        tool: 'Connect Systems Factory Tool',
        windows: 'Use the .bin file with the Factory Tool, with the radio in the same flashing mode.',
        url: 'https://www.connectsystems.com/amateur-software/CS7000_m17_plus_software.html',
      },
    },
    verified: null,
  },
  {
    id: 'rt4d',
    heldKeysDrawn: true,
    name: 'Radtel RT-4D',
    method: 'rt4d-serial',
    ext: 'bin',
    enter: [
      'Turn the radio off and plug the two-pin programming cable into the side of the radio.',
      'Hold PTT, then turn the radio on.',
      'The screen stays dark: the radio is in flashing mode.',
    ],
    enterUnconfirmed: true,
    after: 'Turn the radio off and on again.',
    manual: {
      tool: 'RT-4D-python-flasher',
      command: 'python3 flash.py <serial port> {file}',
      url: 'https://github.com/fagci/RT-4D-python-flasher',
    },
    verified: null,
  },
  {
    id: 'rt950pro',
    heldKeysDrawn: true,
    name: 'Radtel RT-950 Pro',
    method: 'rt950-serial',
    ext: 'btf',
    // The port's build is openrtx_rt950pro.BTF; any .BTF is taken, and the flasher
    // checks the model name inside before it sends anything.
    alsoMatches: '\\.btf$',
    enter: [
      'Turn the radio off and plug the programming cable into the side of the radio.',
      'Hold both side keys below the PTT, then turn the radio on.',
      'It does not start as usual: the radio is in flashing mode (Radtel calls it update mode).',
    ],
    after: 'The radio restarts by itself with the new firmware.',
    flashNotes: [
      "The radio's own bootloader is kept, so Radtel's update tool can put the original firmware back.",
    ],
    manual: {
      tool: 'rt950_flash.py',
      command: 'python3 scripts/rt950_flash.py upload <serial port> {file} --ptt',
      url: 'https://github.com/Marko13-dev/OpenRTX/tree/rt950pro/platform/targets/rt950pro',
    },
    verified: null,
  },
  {
    id: 'mod17',
    name: 'Module 17',
    method: 'stm32-dfu',
    ext: 'bin',
    address: 0x08000000,
    enter: [
      'Connect the USB cable.',
      'Hold Esc (upper left) and press the reset switch. With the rev 1.0 enclosure, set the rear switch to “FW Update” and press reset.',
      'The computer sees an “STM32 BOOTLOADER” device.',
    ],
    after: 'Press reset (and set the rear switch back, if you used it).',
    manual: {
      tool: 'dfu-util',
      command: 'dfu-util -d 0483:df11 -a 0 -s 0x08000000 -D {file}',
      url: 'https://dfu-util.sourceforge.net/',
    },
    verified: null,
  },
  {
    id: 'ttwrplus',
    name: 'Lilygo T-TWR Plus',
    method: 'uf2-copy',
    ext: 'uf2',
    enter: [
      'Connect the USB-C cable.',
      'Turn the radio on and press BOOT (Volume −) right after.',
      'A USB drive appears on the computer.',
    ],
    after:
      'The radio restarts by itself. If it does not, hold the power button for ten seconds and press it again.',
    flashNotes: [
      'The radio module (SA868S) needs the open sa8x8 firmware first; see the OpenRTX T-TWR Plus page.',
      'The original firmware cannot be flashed back.',
    ],
    manual: {
      tool: 'your file manager',
      url: 'https://openrtx.org/#/hardware/ttwrplus',
    },
    verified: null,
  },
  {
    id: 'c62',
    heldKeysDrawn: true,
    name: 'Retevis C62 / C2',
    method: 'csk-serial',
    ext: 'bin',
    alsoMatches: '(^|/)zephyr\\.bin$',
    // OpenRTX loads its DSP firmware from here at every start; with the original
    // firmware's image there instead, the radio stops at a black screen.
    alsoWrites: [{ file: 'dsp_firmware.bin', address: 0x100000, what: 'DSP image' }],
    enter: [
      'Turn the radio off and plug a K-plug serial programming cable into the side of the radio.',
      'Hold the secondary PTT (the lower side button), turn the radio on, then release.',
      'The screen stays dark: the radio is in flashing mode (LISTENAI calls it burn mode). Do not press the main PTT while flashing.',
    ],
    after: 'Turn the radio off and on again.',
    manual: {
      tool: 'cskburn',
      command: 'cskburn -C 6 -b 115200 -s <serial port> --verify-all 0x100000 dsp_firmware.bin 0x0 {file}',
      url: 'https://github.com/LISTENAI/cskburn',
    },
    // docs/verification.md, 2026-11-21.
    verified: { version: 'a CI build of 20 Nov 2026', platform: 'Chrome 156, macOS', date: '2026-11-21' },
  },
];

/** Looks a radio up by its OpenRTX target name. */
export function radioById(id: string): Radio | undefined {
  return RADIOS.find((r) => r.id === id);
}

/** True when `fileName` (possibly with a folder prefix) is a build for `radio` with extension `ext`. */
function matches(radio: Radio, fileName: string, ext: string): boolean {
  const parts = fileName.split('/');
  const base = parts.pop()!.toLowerCase();
  // The firmware mirror keeps a radio's plainly named files (zephyr.bin) in a folder
  // named after the radio; such a file is no other radio's.
  const folder = parts.pop();
  if (folder !== undefined && folder !== radio.id && RADIOS.some((r) => r.id === folder)) return false;
  if (base.startsWith(`openrtx_${radio.id}_`) || base === `openrtx_${radio.id}.${ext}`) {
    return base.endsWith(`.${ext}`);
  }
  return ext === radio.ext && !!radio.alsoMatches && new RegExp(radio.alsoMatches, 'i').test(fileName);
}

/** The file from `names` to flash onto `radio` in the browser, if the build has one. */
export function pickFile(radio: Radio, names: string[]): string | undefined {
  return names.find((n) => matches(radio, n, radio.ext));
}

/** Every file in `names` that belongs to `radio`, flashable one first. */
export function filesFor(radio: Radio, names: string[]): string[] {
  const exts = [radio.ext, ...(radio.otherExts ?? [])];
  return exts.flatMap((ext) => names.filter((n) => matches(radio, n, ext)));
}

/** The radio a firmware file name belongs to, for files dropped on the page. */
export function radioForFile(fileName: string): Radio | undefined {
  return RADIOS.find((r) => filesFor(r, [fileName]).length > 0);
}

/** Web API a flashing method needs. */
export function apiFor(method: Method): 'usb' | 'serial' | 'hid' | null {
  switch (method) {
    case 'tyt-dfu':
    case 'stm32-dfu':
    case 'cs7000-robot':
      return 'usb';
    case 'gd77-hid':
      return 'hid';
    case 'rt4d-serial':
    case 'rt950-serial':
    case 'csk-serial':
      return 'serial';
    case 'uf2-copy':
      return null;
  }
}

/** How what a radio holds now can be saved before it is replaced. */
export type Backup =
  | {
      how: 'read';
      /**
       * The state the radio must be in: flashing mode, or normal mode so that its
       * original firmware answers.
       */
      mode: 'flashing' | 'normal';
      /** How long the read takes, for the user. */
      time: string;
      /** What the backup holds, for the user. */
      holds: string;
      /** What happens to the radio once the read is done, when the user should know. */
      after?: string;
      /** True when reading ends flashing mode, so the radio must be put in it again to flash. */
      endsFlashingMode?: boolean;
      /** True when this way of reading has not been measured on this model. */
      unchecked?: boolean;
      /** Something the user should know before relying on it. */
      caveat?: string;
      /** What the backup cannot hold, and where to get it instead; said before the read. */
      notIncluded?: { text: string; label: string; url: string };
      /** Whether this page can write the backup back to the radio. */
      restorable: boolean;
      /** The same backup with the usual tool, where there is one. */
      command?: string;
    }
  /** The user copies a file themselves. */
  | { how: 'copy'; text: string }
  /** The radio gives nothing up in the mode it is flashed in. */
  | { how: 'none'; text: string };

const MIB = 1024 * 1024;

/** What backing up `radio` involves. The page always reads everything it can. */
export function backupFor(radio: Radio): Backup {
  switch (radio.method) {
    case 'csk-serial':
      return {
        how: 'read',
        mode: 'flashing',
        time: 'about ten minutes',
        holds: 'the whole flash: firmware, calibration, channels and settings',
        endsFlashingMode: true,
        restorable: true,
        command:
          'cskburn -C 6 -b 115200 -s <serial port> --chip-id --verify-all --read 0x0:0x400000:backup.bin',
      };
    case 'stm32-dfu': {
      const size = radio.chip === 'h743' ? 2 * MIB : MIB;
      return {
        how: 'read',
        mode: 'flashing',
        time: 'under a minute',
        holds: 'the whole program memory, bootloader included',
        restorable: true,
        command: `dfu-util -d 0483:df11 -a 0 -s 0x08000000:${size} -U backup.bin`,
      };
    }
    case 'tyt-dfu':
      return {
        how: 'read',
        mode: 'normal',
        time: 'up to six minutes',
        holds:
          'the factory data, the bootloader and the whole memory chip that holds your channels and settings',
        after: 'The radio restarts by itself when the read is done.',
        unchecked: radio.id !== 'md9600',
        caveat:
          radio.id === 'md9600'
            ? undefined
            : 'This read has been measured on the MD-9600 only. This model may give less; whatever it gives is kept, and the backup says what is missing. Keep a codeplug read with the programming software as well.',
        restorable: false,
      };
    case 'gd77-hid':
      return {
        how: 'read',
        mode: 'normal',
        time: 'about a minute',
        holds: 'your channels and settings and, where the firmware allows it, the factory calibration',
        caveat:
          'Not every firmware version lets the calibration be read this way. The backup says if it could not.',
        restorable: false,
      };
    case 'rt4d-serial':
      return {
        how: 'read',
        mode: 'normal',
        time: 'about seven minutes',
        holds:
          'the first 4 MB of the memory chip: calibration, settings, channels, zones, contacts, the logo, fonts and voices',
        restorable: false,
      };
    case 'rt950-serial':
      return {
        how: 'read',
        mode: 'normal',
        time: 'under a minute',
        holds:
          'your channels and settings and the factory calibration: the first 64 KB of the memory chip, which is as far as the programming cable reaches',
        unchecked: true,
        caveat:
          'This read has not been run on a real RT-950 Pro yet. It follows the programming protocol as others worked it out; if your radio answers differently, the page says so and saves nothing.',
        notIncluded: {
          text: "The original firmware is not part of the backup, because the radio's bootloader cannot be read. Download the version your radio runs before you flash:",
          label: "Radtel's downloads",
          url: 'https://www.radtels.com/pages/software-download',
        },
        restorable: false,
      };
    case 'cs7000-robot':
      return {
        how: 'none',
        text: 'A radio with its Connect Systems firmware cannot be backed up: that firmware read-protects the chip, and the flashing mode has no way to read. Flashing OpenRTX leaves the bootloader and the DMR firmware in place, and Connect Systems publishes both.',
      };
    case 'uf2-copy':
      return {
        how: 'copy',
        text: 'The drive holds what the radio runs now as CURRENT.UF2. Copy that file to your computer before you copy the new one over.',
      };
  }
}
