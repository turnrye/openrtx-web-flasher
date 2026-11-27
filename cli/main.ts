// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The command line: what the page does, from a terminal. It walks the same steps with
 * the same catalogue, flashers, readers and backup format, and keeps the page's
 * safeguards: it asks before it writes, it does not talk to a radio nobody has checked
 * it on without being told to, and the flashers refuse a radio in the wrong state.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeBundle } from '../src/backup/bundle.ts';
import type { RadioBackup } from '../src/backup/types.ts';
import { COVERAGE_DOC_URL, gapLine, gapsFor, openRtxLimit } from '../src/coverage.ts';
import type { DeviceEnv } from '../src/devices.ts';
import { driverFor } from '../src/drivers/index.ts';
import { asksForSuccess, reportUrl, type Report } from '../src/feedback.ts';
import { companionsFor, fileForRadio, sha256Hex, type Build } from '../src/firmware/builds.ts';
import type { Fetcher } from '../src/firmware/github.ts';
import type { CskModuleLoader } from '../src/flash/csk.ts';
import {
  flashDevice,
  pickDevice,
  restoreRefusal,
  setCskburnLoader,
  SIMULATED_BACKUP,
  type PickedDevice,
  type Purpose,
} from '../src/flash/run.ts';
import { WrongRadioError, type FlashContext, type Segment } from '../src/flash/types.ts';
import {
  apiFor,
  backupFor,
  filesFor,
  forCommandLine,
  idIsPerUnit,
  radioById,
  RADIOS,
  type Radio,
  type Verification,
} from '../src/radios.ts';
import { parse, USAGE, UsageError, type Options } from './args.ts';
import { checkWritable, knownBackups, saveBackup } from './backups.ts';
import { nativeCskburn, platformName, wasmCskburn } from './cskburn.ts';
import { DEFAULT_REPO, developmentRun, fileData, releases, resolveBuild, type Source } from './firmware.ts';
import { formatSize, type Io } from './io.ts';
import { nodeEnv, portLabel, type NodeModules } from './node-env.ts';
import type { NodeSerialPort } from './node-serial.ts';
import { backupProblems, flashProblems, simDevices, type SimProbes } from './sim.ts';

/**
 * The shape of `backupDevice`: told which radios are already backed up, it says so
 * instead of reading one of them again.
 */
export type ReadBackup = (
  radio: Radio,
  picked: PickedDevice,
  ctx: FlashContext,
  size?: number,
  known?: (radioId: string) => boolean,
) => Promise<RadioBackup | { known: string }>;

/** Everything the command line takes from its surroundings, so tests can stand in for it. */
export interface Host {
  io: Io;
  fetch: Fetcher;
  /** The environment: GITHUB_TOKEN and FEEDBACK_URL are looked at. */
  env: Record<string, string | undefined>;
  /** The per-user cache folder; null keeps nothing. */
  cache: string | null;
  /** The packages that reach real devices. */
  modules: NodeModules;
  /** The cskburn program for this computer, or null when there is none. */
  cskburn(): Promise<string | null>;
  /** Reads a radio for a backup. */
  readBackup: ReadBackup;
  /** The time, for a backup's name. */
  now(): Date;
}

/**
 * What this tool was checked for on real hardware: by radio id, then by what was done,
 * flashing or backing up. One does not stand for the other: they are different code and,
 * on many radios, a different mode of the radio. Empty until someone does it: `verified`
 * in src/radios.ts is about the page in Chrome, which reaches the radio through another
 * USB and serial layer.
 */
const CHECKED: Partial<Record<string, Partial<Record<Purpose, Verification>>>> = {
  md9600: {
    flash: {
      version: 'development build 242dcee0',
      platform: 'Node 26.9, macOS on Apple silicon',
      date: '2026-11-25',
    },
  },
  cs7000p: {
    flash: {
      version: 'development build 9951a7d1',
      platform: 'Node 26.9, macOS on Apple silicon, robot mode',
      date: '2026-11-24',
    },
  },
};

/** What a purpose is called, at the start of a sentence and inside one. */
const DOING: Record<Purpose, [string, string]> = {
  flash: ['Flashing', 'flashing'],
  backup: ['Backing up', 'backing up'],
};

/** The devices of one run: real ones, or the simulators. */
interface Devices {
  env: DeviceEnv;
  /** The cskburn to run for a C62 on `port`. */
  cskburn(port: SerialPort): Promise<CskModuleLoader>;
  /** The simulated radios' probes; absent with real hardware. */
  probes?: SimProbes;
}

/** An environment variable's value; an empty one counts as not set. */
function setting(value: string | undefined): string | undefined {
  return value === '' ? undefined : value;
}

/** Text of a thrown value. */
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** "2026-10-04" from an ISO date; empty for none. */
function day(iso?: string): string {
  return iso ? iso.slice(0, 10) : '';
}

/** The devices `options` ask for. */
function devicesFor(options: Options, host: Host): Devices {
  if (options.sim !== undefined) {
    return { ...simDevices(options.sim), cskburn: () => Promise.resolve(wasmCskburn()) };
  }
  return {
    env: nodeEnv(host.modules, host.io, options.port),
    cskburn: async (port) => {
      const binary = options.cskburn ?? (await host.cskburn());
      if (!binary) {
        throw new Error(
          `There is no ready-made cskburn for this computer (${platformName()}). ` +
            'Build it from https://github.com/LISTENAI/cskburn and name it with --cskburn.',
        );
      }
      return nativeCskburn(binary, (port as unknown as NodeSerialPort).path);
    },
  };
}

/**
 * Finds the radio's device, and for a C62 points the flasher at the cskburn that goes
 * with it. When there is no device to use it says why and returns null: nothing has
 * been sent to a radio then, so it is not a failed flash or backup.
 */
async function pick(radio: Radio, devices: Devices, purpose: Purpose, io: Io): Promise<PickedDevice | null> {
  try {
    const picked = await pickDevice(radio, devices.env, purpose);
    const driver = driverFor(radio);
    if (picked.api === 'serial' && driver.api === 'serial' && driver.cskburn) {
      setCskburnLoader(await devices.cskburn(picked.device));
    }
    return picked;
  } catch (e) {
    io.say(messageOf(e));
    return null;
  }
}

/** The radio called `id`, whatever its case. */
function radioNamed(id: string): Radio {
  const radio = radioById(id.toLowerCase());
  if (!radio) throw new Error(`There is no radio "${id}". "openrtx-flasher radios" lists them.`);
  return forCommandLine(radio);
}

/** What this computer needs before it can reach `radio`, when that is something. */
function platformNote(radio: Radio): string | null {
  const driver = driverFor(radio);
  if (driver.api === 'usb' && driver.massStorage) {
    if (process.platform === 'win32') {
      return 'Windows keeps this kind of USB device to itself. Use the Connect Systems Factory Tool with the .bin file instead.';
    }
    if (process.platform === 'darwin' && process.getuid?.() !== 0) {
      return 'macOS keeps USB drives to itself, and only an administrator can take one over. Run this command with "sudo" in front.';
    }
    return null;
  }
  return process.platform === 'win32' && driver.api === 'usb'
    ? 'On Windows the radio needs the WinUSB driver. Install it once with Zadig while the radio is in flashing mode.'
    : null;
}

/** The command of the radio's usual tool for `file`; undefined when the tool has none. */
function manualCommand(radio: Radio, file: string): string | undefined {
  return radio.manual.command?.replace('{file}', file).replace('{model}', radio.hidModel ?? '');
}

/** How a radio is connected, in a word or two. */
function connection(radio: Radio): string {
  const api = apiFor(radio.method);
  return api === 'serial' ? 'serial programming cable' : api === null ? 'USB drive' : 'USB';
}

/** What a backup of `radio` is, in a few words. */
function backupSummary(radio: Radio): string {
  const backup = backupFor(radio);
  if (backup.how === 'none') return 'not possible';
  if (backup.how !== 'read') return 'copy a file off its drive';
  return `read in ${backup.mode} mode, ${backup.time}; ${backup.restorable ? 'can be flashed back' : 'a record, cannot be written back'}`;
}

/**
 * Says what a backup of `radio` leaves out, from the coverage record. `linked` is true
 * when a line before this one already gave the address of the coverage document.
 */
function sayGaps(radio: Radio, io: Io, indent: string, linked: boolean): void {
  const gaps = gapsFor(radio);
  if (gaps.length === 0) {
    io.say(`${indent}That is every memory the radio has.`);
  } else {
    io.say(`${indent}Not saved whole, each a critical gap:`);
    for (const gap of gaps) io.say(`${indent}  - ${gapLine(gap)}`);
    if (!linked) io.say(`${indent}What is lost, and how each gap can be closed: ${COVERAGE_DOC_URL}`);
  }
  const limit = openRtxLimit(radio);
  if (limit) io.say(`${indent}${limit}`);
}

/** What is known about `radio` on real hardware: this tool, and the page. */
function checkedSummary(radio: Radio): string {
  const here = Object.entries(CHECKED[radio.id] ?? {}) as [Purpose, Verification][];
  const page = radio.verified;
  return [
    here.length > 0
      ? `this tool was checked on a real one for ${here.map(([purpose, { date }]) => `${DOING[purpose][1]} (${date})`).join(' and ')}`
      : 'this tool has not been checked on a real one',
    page ? `the web page was (${page.date})` : 'nor has the web page',
  ].join('; ');
}

/** `radios`: every radio in two lines, or one radio in full. */
function showRadios(id: string | undefined, { io }: Host): number {
  if (id === undefined) {
    io.say('Radios, by the name to use for <radio>:');
    io.say();
    for (const radio of RADIOS.map(forCommandLine)) {
      io.say(`  ${radio.id.padEnd(9)} ${radio.name}${radio.aka ? ` (${radio.aka})` : ''}`);
      io.say(`  ${''.padEnd(9)} ${connection(radio)}; backup: ${backupSummary(radio)}`);
    }
    io.say();
    for (const purpose of ['flash', 'backup'] as const) {
      const checked = RADIOS.filter((radio) => CHECKED[radio.id]?.[purpose]).map((radio) => radio.id);
      io.say(
        `${DOING[purpose][0]} was checked with this tool on real hardware for: ${checked.join(', ') || 'none of them yet'}.`,
      );
    }
    io.say('"openrtx-flasher radios <radio>" says what one of them needs.');
    return 0;
  }
  const radio = radioNamed(id);
  const backup = backupFor(radio);
  io.say(`${radio.name}${radio.aka ? ` (${radio.aka})` : ''}`);
  io.say(`  Connection: ${connection(radio)}`);
  io.say(`  Firmware: a .${radio.ext} file`);
  for (const c of radio.alsoWrites ?? []) {
    io.say(
      `  Also needs ${c.file} from the same build: the ${c.what}, written at 0x${c.address.toString(16)}`,
    );
  }
  io.say(`  On real hardware: ${checkedSummary(radio)}`);
  io.say();
  io.say(
    `Flashing mode${radio.enterUnconfirmed ? ' (a best guess: the OpenRTX documentation does not say)' : ''}:`,
  );
  radio.enter.forEach((step, i) => io.say(`  ${i + 1}. ${step}`));
  io.say(`After flashing: ${radio.after}`);
  for (const note of radio.flashNotes ?? []) io.say(`  - ${note}`);
  io.say();
  if (backup.how === 'read') {
    io.say(`Backup: ${backupSummary(radio)}.`);
    io.say(`  It holds ${backup.holds}.`);
    if (backup.caveat) io.say(`  ${backup.caveat}`);
    if (backup.notIncluded) io.say(`  ${backup.notIncluded.text} ${backup.notIncluded.url}`);
    if (backup.after) io.say(`  ${backup.after}`);
    sayGaps(radio, io, '  ', backup.notIncluded?.url === COVERAGE_DOC_URL);
  } else {
    io.say(`Backup: ${backup.text}`);
    sayGaps(radio, io, '  ', false);
  }
  io.say();
  io.say(`The usual tool: ${radio.manual.tool}, ${radio.manual.url}`);
  if (radio.manual.command) io.say(`  ${manualCommand(radio, '<file>')}`);
  return 0;
}

/** How firmware is fetched for this host. */
function sourceOf(host: Host): Source {
  return {
    fetch: host.fetch,
    token: setting(host.env.GITHUB_TOKEN),
    cache: host.cache,
    say: (line) => host.io.say(line),
  };
}

/** `firmware`: the releases and the development build of the repository. */
async function showFirmware(options: Options, host: Host): Promise<number> {
  const { io } = host;
  const source = sourceOf(host);
  io.say(`Firmware from ${options.repo ?? DEFAULT_REPO}, by the word to use for <firmware>:`);
  io.say();
  const found = await releases(options.repo, source);
  found.forEach((build, i) => {
    io.say(
      `  ${(i === 0 ? 'release' : build.label).padEnd(9)} ${i === 0 ? `${build.label}, ` : ''}${day(build.date)}`,
    );
  });
  if (found.length === 0) io.say('  No release has firmware attached.');
  try {
    const run = await developmentRun(options.repo, source);
    // The label of a fork's build starts with its owner; the branch is the word to use.
    const branch = run.label.split(': ').pop()!;
    io.say(`  ${branch.padEnd(9)} the development build of ${day(run.date)}, commit ${run.sha.slice(0, 7)}`);
  } catch (e) {
    io.say(`  The development build: ${messageOf(e)}`);
  }
  io.say();
  io.say('Also: a pull request number, a branch, owner:branch for a fork, or a file.');
  return 0;
}

/** `ports`: the serial ports of this computer. */
async function showPorts(options: Options, { io, modules }: Host): Promise<number> {
  if (options.sim !== undefined) {
    io.say('A simulated radio needs no port.');
    return 0;
  }
  const ports = await (await modules.serial()).SerialPort.list();
  if (ports.length === 0) io.say('This computer has no serial port. Plug in the programming cable.');
  for (const port of ports) io.say(portLabel(port));
  return 0;
}

/** Why `build` has nothing to write to `radio`. */
function nothingFor(radio: Radio, build: Build): string {
  if (build.backup && build.backup.radio !== radio.id) {
    return `This backup is of a ${build.backup.model}, not a ${radio.name}.`;
  }
  if (build.backup) {
    return (
      'This backup was read through the radio’s original firmware. It is a record of what could be read from ' +
      'the radio and cannot be written back.'
    );
  }
  return (
    `${build.label} has no firmware for the ${radio.name}. ` +
    `Its file is called openrtx_${radio.id}_<version>.${radio.ext}` +
    (radio.alsoMatches && new RegExp(radio.alsoMatches, 'i').test('zephyr.bin') ? ' (or zephyr.bin).' : '.')
  );
}

/** `fetch`: saves the files of a build that belong to a radio. */
async function fetchFiles(radio: Radio, what: string, options: Options, host: Host): Promise<number> {
  const { io } = host;
  const source = sourceOf(host);
  const build = await resolveBuild(what, radio, options.repo, source);
  if (build.backup) throw new Error('That is a backup, not firmware.');
  const names = build.files.map((f) => f.name);
  const wanted = [
    ...filesFor(radio, names),
    ...(radio.alsoWrites ?? []).map((c) => c.file).filter((name) => names.includes(name)),
  ];
  if (wanted.length === 0) throw new Error(nothingFor(radio, build));
  mkdirSync(options.out, { recursive: true });
  for (const name of wanted) {
    const data = await fileData(
      build,
      build.files.find((f) => f.name === name)!,
      source,
    );
    const path = join(options.out, name.split(/[\\/]/).pop()!);
    writeFileSync(path, data);
    io.say(`Saved ${path} (${formatSize(data.length)}, SHA-256 ${await sha256Hex(data)})`);
  }
  const command = manualCommand(radio, wanted[0]);
  io.say(`To write it yourself: ${radio.manual.tool}, ${radio.manual.url}`);
  if (command) io.say(`  ${command}`);
  return 0;
}

/**
 * The page's experimental gate: whether to talk to `radio` for `purpose` at all. Yes when
 * it is simulated or this tool was checked on it for that; otherwise only when the person
 * says so.
 */
async function allowed(radio: Radio, purpose: Purpose, options: Options, { io }: Host): Promise<boolean> {
  if (options.sim !== undefined) {
    io.say('Simulator: this goes to a simulated radio. Nothing is sent to real hardware.');
    return true;
  }
  const here = CHECKED[radio.id]?.[purpose];
  if (here) {
    io.say(
      `${DOING[purpose][0]} was checked on a real radio: ${[here.version, here.platform, here.date].filter(Boolean).join(', ')}.`,
    );
    return true;
  }
  const other: Purpose = purpose === 'flash' ? 'backup' : 'flash';
  io.say(
    `Nobody has checked ${DOING[purpose][1]} a real ${radio.name} with this command-line tool yet. ` +
      (purpose === 'flash'
        ? 'A failed flash can leave the radio without working firmware until you flash it again with the usual tool.'
        : 'Reading does not change the radio, but what an unchecked reader saves may be wrong or incomplete.'),
  );
  const otherCheck = CHECKED[radio.id]?.[other];
  if (otherCheck) {
    io.say(
      `${DOING[other][0]} one was checked (${otherCheck.date}); ${DOING[purpose][1]} is another path through this tool.`,
    );
  }
  if (radio.verified) io.say('The web page was checked on one; this tool reaches the radio another way.');
  const question = purpose === 'flash' ? 'I can recover my radio: go on?' : 'Read the radio all the same?';
  if (options.experimental || (await io.confirm(question))) return true;
  io.say(`Stopped${io.interactive ? '' : ': add --experimental to go on'}. Nothing was sent to the radio.`);
  return false;
}

/** A report link, as the page makes them: it opens the tracker with the report filled in. */
function reportLink(host: Host, report: Omit<Report, 'userAgent' | 'buildId'>): string {
  return reportUrl(setting(host.env.FEEDBACK_URL) ?? __FEEDBACK_URL__, {
    ...report,
    userAgent: `openrtx-flasher command line, Node ${process.version}, ${platformName()}`,
    buildId: __BUILD_ID__,
  });
}

/** The context a flasher or reader runs in: its lines are printed and kept for a report. */
function contextFor(devices: Devices, io: Io, log: string[]): FlashContext {
  return {
    log: (line) => {
      log.push(line);
      io.say(`  ${line}`);
    },
    progress: (p) => io.progress(p),
    sleep: (ms) => devices.env.sleep(ms),
  };
}

/** Says how a simulated radio compares with what was done to it; the exit code is 1 when it differs. */
function simVerdict(io: Io, problems: string[], good: string): number {
  problems.forEach((problem) => io.say(`Simulator: ${problem}.`));
  if (problems.length === 0) io.say(`Simulator: ${good}`);
  return problems.length === 0 ? 0 : 1;
}

/** `flash`: writes a build, or a backup, to the radio. */
async function flash(radio: Radio, what: string, options: Options, host: Host): Promise<number> {
  const { io } = host;
  if (apiFor(radio.method) === null) {
    io.say(`The ${radio.name} is flashed by copying a file onto its USB drive:`);
    radio.enter.forEach((step, i) => io.say(`  ${i + 1}. ${step}`));
    io.say(`Get the file with "openrtx-flasher fetch ${radio.id} ${what}" and copy it onto the drive.`);
    return 1;
  }
  const source = sourceOf(host);
  const build = await resolveBuild(what, radio, options.repo, source);
  const file = fileForRadio(radio, build);
  if (!file) throw new Error(nothingFor(radio, build));
  // Said before anything else: no walk through flashing mode for a write that will not happen.
  const way = backupFor(radio);
  if (build.backup && !(way.how === 'read' && way.restorable)) {
    throw new Error(
      `This is a backup of the whole flash. The flashing mode this tool uses for the ${radio.name} ` +
        'cannot write one. Nothing was sent to the radio.',
    );
  }
  if (build.backup?.simulated && options.sim === undefined) throw new Error(SIMULATED_BACKUP);
  const data = await fileData(build, file, source);
  const hash = file.sha256 ?? (await sha256Hex(data));
  const companions = companionsFor(radio, build);
  const also: Segment[] = [];
  for (const c of companions) {
    if (c.found) also.push({ address: c.address, data: await fileData(build, c.found, source) });
  }

  io.say(`${build.label} for the ${radio.name}`);
  io.say(`  ${file.name}, ${formatSize(data.length)}, SHA-256 ${hash}`);
  companions.forEach((c) => {
    if (c.found) {
      io.say(
        `  ${c.file}, ${formatSize(c.found.size)}: the ${c.what}, written at 0x${c.address.toString(16)} in the same run`,
      );
    } else {
      io.say(
        `This build has no ${c.file}. OpenRTX on the ${radio.name} needs its ${c.what} as well as ${file.name}: ` +
          'without it the radio starts with a black screen. Use the build zip, which has both, unless this ' +
          'radio already runs OpenRTX.',
      );
    }
  });
  if (build.backup) io.say('This is a backup. Only restore it onto the radio it came from.');
  for (const note of radio.flashNotes ?? []) io.say(`  - ${note}`);
  const needs = options.sim === undefined ? platformNote(radio) : null;
  if (needs) io.say(needs);
  io.say();
  if (!(await allowed(radio, 'flash', options, host))) return 1;

  io.say(
    `Put the radio in flashing mode${radio.enterUnconfirmed ? ' (a best guess: the OpenRTX documentation does not say)' : ''}:`,
  );
  radio.enter.forEach((step, i) => io.say(`  ${i + 1}. ${step}`));
  if (!options.yes && !(await io.confirm(`Write ${file.name} to the ${radio.name} now?`))) {
    io.say(
      `Stopped${io.interactive ? '' : ': add --yes to write without being asked'}. Nothing was sent to the radio.`,
    );
    return 1;
  }

  const devices = devicesFor(options, host);
  const log: string[] = [];
  const ctx = contextFor(devices, io, log);
  const about = {
    step: 'flash' as const,
    radio: { id: radio.id, name: radio.name },
    firmware: {
      label: build.label,
      file: [file.name, ...companions.filter((c) => c.found).map((c) => c.file)].join(' + '),
      sha256: hash,
    },
  };
  const picked = await pick(radio, devices, 'flash', io);
  if (!picked) return 1;
  // A radio that says who it is before anything is sent: flashDevice would refuse it too.
  const other = build.backup ? restoreRefusal(build.backup, picked) : null;
  if (other) {
    io.say(other);
    return 1;
  }
  try {
    ctx.log(`Flashing ${file.name} (${data.length} bytes) to ${radio.name}`);
    io.say('Do not unplug or switch off the radio.');
    await flashDevice(radio, picked, data, ctx, build.backup ?? null, also);
  } catch (e) {
    const message = messageOf(e);
    // The backup is of another radio: nothing was written, and nothing went wrong to report.
    if (e instanceof WrongRadioError) {
      io.say(message);
      return 1;
    }
    io.say(`Failed: ${message} Put the radio back in flashing mode and try again.`);
    if (!devices.probes) {
      io.say(`To report this: ${reportLink(host, { ...about, outcome: 'failed', error: message, log })}`);
    }
    return 1;
  }
  io.say(`Done. ${radio.after}`);
  if (devices.probes) {
    return simVerdict(
      io,
      flashProblems(devices.probes, data, !!build.backup, also),
      'the simulated radio holds exactly what was written.',
    );
  }
  const failed = { ...about, outcome: 'failed' as const, log };
  if (asksForSuccess(CHECKED[radio.id]?.flash !== undefined)) {
    io.say(`Did the radio start OpenRTX? Your answer helps get the ${radio.name} checked with this tool.`);
    io.say(`  Yes: ${reportLink(host, { ...about, outcome: 'worked' })}`);
    io.say(
      `  No:  ${reportLink(host, { ...failed, error: 'The tool said done, but the radio did not start OpenRTX.' })}`,
    );
    io.say(
      'A link opens the issue tracker with the report filled in, for you to read and send. Nothing is sent by itself.',
    );
  }
  return 0;
}

/** `backup`: reads the radio into a backup zip in --out. */
async function backup(radio: Radio, options: Options, host: Host): Promise<number> {
  const { io } = host;
  const info = backupFor(radio);
  if (info.how !== 'read') {
    io.say(info.text);
    sayGaps(radio, io, '', false);
    return info.how === 'copy' ? 0 : 1;
  }
  // Before anything else: a read is long, and its result must have somewhere to go.
  checkWritable(options.out);
  io.say(`Backing up the ${radio.name}: ${info.holds}. It takes ${info.time}.`);
  io.say(
    info.restorable
      ? 'The backup is the way back to what the radio runs now: "flash" can write it back.'
      : 'The backup cannot be written back. It is a record of what could be read from the radio, not of everything in it.',
  );
  if (info.caveat) io.say(info.caveat);
  if (info.notIncluded) io.say(`${info.notIncluded.text} ${info.notIncluded.url}`);
  sayGaps(radio, io, '', info.notIncluded?.url === COVERAGE_DOC_URL);
  io.say();
  if (!(await allowed(radio, 'backup', options, host))) return 1;
  if (info.mode === 'normal') {
    io.say(
      'The radio must be in normal mode: switched on without holding any keys, with the programming cable connected.',
    );
  } else {
    io.say('The radio must be in flashing mode:');
    radio.enter.forEach((step, i) => io.say(`  ${i + 1}. ${step}`));
  }

  const devices = devicesFor(options, host);
  const known = options.again ? new Map<string, string>() : knownBackups(options.out, radio.id);
  const log: string[] = [];
  const picked = await pick(radio, devices, 'backup', io);
  if (!picked) return 1;
  try {
    io.say('Do not unplug or switch off the radio.');
    const read = await host.readBackup(
      radio,
      picked,
      contextFor(devices, io, log),
      devices.env.backupSize?.(radio),
      (id) => known.has(id),
    );
    if ('known' in read) {
      io.say(
        `This radio (ID ending ${read.known.slice(-8)}) already has a backup in ${options.out}: ` +
          `${known.get(read.known) ?? 'see there'}. Nothing more was read. Add --again to read it anyway.`,
      );
      return 0;
    }
    const source = info.mode === 'normal' ? 'original-firmware' : 'flashing-mode';
    const { name, zip, manifest } = await makeBundle(radio, read, source, host.now());
    let path;
    try {
      path = saveBackup(options.out, name, zip);
    } catch (e) {
      // The radio was read; it is the saving that failed, so the advice is about the folder.
      io.say(`The radio was read, but the backup could not be saved in ${options.out}: ${messageOf(e)}`);
      io.say('Name a folder you can write to with --out and read the radio again.');
      return 1;
    }
    io.say(`Saved ${path} (${formatSize(zip.length)}).`);
    io.say(`  Radio ID: ${manifest.radioId ?? 'this radio does not report one'}`);
    const earlier = manifest.radioId && !idIsPerUnit(radio) ? known.get(manifest.radioId) : undefined;
    if (earlier) {
      io.say(
        `  That is the ID of ${earlier} as well. It is not yet known whether two of these radios can ` +
          'have the same ID, so the radio was read again.',
      );
    }
    if (manifest.firmware) io.say(`  Firmware on the radio: ${manifest.firmware}`);
    for (const part of manifest.parts.filter((p) => !p.complete)) {
      io.say(`  ${part.file} is incomplete${part.note ? `: ${part.note}` : '.'}`);
    }
    for (const note of manifest.notes) io.say(`  ${note}`);
    io.say('Keep it, and keep it private: it is specific to your radio.');
    if (info.after) io.say(info.after);
    if (info.endsFlashingMode) {
      io.say('Reading ended flashing mode. Put the radio in flashing mode again before you flash it.');
    }
    if (devices.probes) {
      return simVerdict(
        io,
        backupProblems(devices.probes, source, read),
        'the backup holds exactly what the simulated radio held, and nothing was written to it.',
      );
    }
  } catch (e) {
    const message = messageOf(e);
    const again =
      info.mode === 'normal'
        ? 'Check that the radio is in normal mode and try again.'
        : 'Put the radio back in flashing mode and try again.';
    io.say(`Failed: ${message} ${again}`);
    if (!devices.probes) {
      const report = { outcome: 'failed' as const, step: 'backup' as const, error: message, log };
      io.say(`To report this: ${reportLink(host, { ...report, radio: { id: radio.id, name: radio.name } })}`);
    }
    return 1;
  }
  return 0;
}

/**
 * Runs one command line (`argv` without node and the script) and returns the exit code:
 * 0 done, 1 not done, 2 not understood.
 */
export async function main(argv: string[], host: Host): Promise<number> {
  const { io } = host;
  let parsed;
  try {
    parsed = parse(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    io.say(e.message);
    io.say('"openrtx-flasher --help" shows what there is.');
    return 2;
  }
  const { command, options } = parsed;
  try {
    switch (command.name) {
      case 'help':
        io.say(USAGE);
        return 0;
      case 'version':
        io.say(`openrtx-flasher, build ${__BUILD_ID__}`);
        return 0;
      case 'radios':
        return showRadios(command.radio, host);
      case 'firmware':
        return await showFirmware(options, host);
      case 'ports':
        return await showPorts(options, host);
      case 'fetch':
        return await fetchFiles(radioNamed(command.radio), command.firmware, options, host);
      case 'backup':
        return await backup(radioNamed(command.radio), options, host);
      case 'flash':
        return await flash(radioNamed(command.radio), command.firmware, options, host);
    }
  } catch (e) {
    io.say(messageOf(e));
    return 1;
  }
}
