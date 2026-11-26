// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The udev rule file that lets the person logged in at a Linux computer reach radios in
 * flashing mode without sudo. Linux gives a new USB device to root; a udev rule is how a
 * device is handed to someone else, and systemd's `uaccess` tag hands it to whoever is
 * logged in at the computer, for as long as they are. It is the same thing dfu-util and
 * hackrf ship in their distribution packages; this tool is not one, so `setup` installs
 * it, once, and the tool runs as the person from then on.
 *
 * The rules are made from the filters the flashers use, so a radio added there is
 * covered here without being listed twice.
 */
import { readFileSync } from 'node:fs';
import { CS7000_ROBOT_FILTERS, DFU_FILTERS, GD77_FILTERS } from '../src/flash/run.ts';
import { forCommandLine, RADIOS, type Radio } from '../src/radios.ts';

/**
 * Where the rule file goes. The number matters: systemd's 73-seat-late.rules is what
 * turns the uaccess tag into access, and a tag added by a file read after it does
 * nothing, without a word.
 */
export const RULES_PATH = '/etc/udev/rules.d/70-openrtx-flasher.rules';

/** One kind of bootloader: its devices and the radios that use it. */
interface Bootloader {
  what: string;
  /** usb for libusb, hidraw for node-hid. */
  subsystem: 'usb' | 'hidraw';
  filters: { vendorId?: number; productId?: number }[];
  methods: Radio['method'][];
}

const BOOTLOADERS: Bootloader[] = [
  {
    what: 'STM32, GD32 and TYT bootloaders (USB DFU)',
    subsystem: 'usb',
    filters: DFU_FILTERS,
    methods: ['stm32-dfu', 'tyt-dfu'],
  },
  {
    what: 'Connect Systems robot mode (a USB drive)',
    subsystem: 'usb',
    filters: CS7000_ROBOT_FILTERS,
    methods: ['cs7000-robot'],
  },
  {
    what: 'NXP bootloader of the GD-77 family (USB HID)',
    subsystem: 'hidraw',
    filters: GD77_FILTERS,
    methods: ['gd77-hid'],
  },
];

/** A USB ID as udev writes it: four lowercase hex digits. */
function hex(id: number | undefined): string {
  return (id ?? 0).toString(16).padStart(4, '0');
}

/** One rule: the device that fits `f` goes to whoever is logged in. */
function rule(subsystem: Bootloader['subsystem'], f: Bootloader['filters'][number]): string {
  return subsystem === 'usb'
    ? `SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="${hex(f.vendorId)}", ATTR{idProduct}=="${hex(f.productId)}", TAG+="uaccess"`
    : `KERNEL=="hidraw*", ATTRS{idVendor}=="${hex(f.vendorId)}", ATTRS{idProduct}=="${hex(f.productId)}", TAG+="uaccess"`;
}

/** The rule file, as `setup` installs it. */
export function udevRules(): string {
  const radios = RADIOS.map(forCommandLine);
  const lines = [
    '# openrtx-flasher: lets the person logged in at this computer reach radios in',
    '# flashing mode without sudo. Installed by "openrtx-flasher setup"; delete this',
    '# file to undo it.',
    '#',
    '# TAG+="uaccess" gives a device to whoever is logged in at the computer, while',
    '# they are: not to other users, and not over SSH. It only works from a file',
    "# numbered below 73, because systemd's 73-seat-late.rules is what acts on it.",
  ];
  for (const b of BOOTLOADERS) {
    const names = radios.filter((r) => b.methods.includes(r.method)).map((r) => r.name);
    lines.push('', `# ${b.what}: ${names.join(', ')}`, ...b.filters.map((f) => rule(b.subsystem, f)));
  }
  return `${lines.join('\n')}\n`;
}

/** A command `setup` runs, and shows. */
export interface Step {
  command: string;
  args: string[];
}

/** The commands that install the rule file from `source` and apply it to radios already connected. */
export function installSteps(source: string, target: string = RULES_PATH): Step[] {
  return [
    { command: 'sudo', args: ['install', '-m', '0644', source, target] },
    { command: 'sudo', args: ['udevadm', 'control', '--reload'] },
    {
      command: 'sudo',
      args: ['udevadm', 'trigger', '--action=change', '--subsystem-match=usb', '--subsystem-match=hidraw'],
    },
  ];
}

/** A step as a person would type it. */
export function shown(step: Step): string {
  return [step.command, ...step.args].map((a) => (/^[\w./=:-]+$/.test(a) ? a : `'${a}'`)).join(' ');
}

/** Whether the rule file at `path` is there and is this version's. */
export function rulesState(path: string): 'missing' | 'current' | 'outdated' {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return 'missing';
  }
  return text === udevRules() ? 'current' : 'outdated';
}
