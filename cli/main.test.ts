// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The command line from end to end: whole commands against the simulated radios of
 * src/sim (--sim), and against the same simulators and a stand-in cskburn behind fake
 * native packages, which is the path a real radio takes. No real device is touched.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { afterAll, describe, expect, it } from 'vitest';
import { makeBundle, openBundle } from '../src/backup/bundle.ts';
import { parseSgl } from '../src/flash/gd77.ts';
import { backupDevice } from '../src/flash/run.ts';
import { RADIOS } from '../src/radios.ts';
import { buildSgl, SimGd77 } from '../src/sim/gd77.ts';
import { buildDfuFile } from '../src/sim/stm32dfu.ts';
import { SimRt4d } from '../src/sim/rt4d.ts';
import { main, type Host } from './main.ts';
import type { NodeModules } from './node-env.ts';
import {
  fakeIo,
  folder,
  hidOver,
  removeFolders,
  serialOver,
  standInCskburn,
  STAND_IN_CHIP_ID,
  type CskburnRecord,
  type FakeIo,
} from './test-support.ts';

/** SHA-256 of `bytes` as hex. */
function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Random bytes as a plain Uint8Array. */
function random(length: number): Uint8Array {
  return new Uint8Array(randomBytes(length));
}

/** Writes `data` as `name` into a new folder and returns its path. */
function fileOf(name: string, data: Uint8Array): string {
  const path = join(folder(), name);
  writeFileSync(path, data);
  return path;
}

/** A package that reaches real devices; no test in this file may get that far unless it brings a fake. */
function untouchable(): Promise<never> {
  return Promise.reject(new Error('a test reached for a real device'));
}

/** A host with nothing real behind it. `answers` makes the terminal interactive. */
function host(
  given: Partial<Omit<Host, 'io'>> = {},
  answers?: (boolean | number | null)[],
): Host & { io: FakeIo } {
  return {
    io: fakeIo(answers),
    fetch: () => Promise.reject(new Error('a test reached for the network')),
    env: {},
    cache: null,
    modules: { usb: untouchable, serial: untouchable, hid: untouchable },
    cskburn: () => Promise.resolve(null),
    readBackup: backupDevice,
    now: () => new Date('2026-11-21T06:05:00'),
    ...given,
  };
}

/** Runs one command line on a fresh host and returns its exit code and what it said. */
async function run(
  argv: string[],
  given: Partial<Omit<Host, 'io'>> = {},
  answers?: (boolean | number | null)[],
) {
  const h = host(given, answers);
  const code = await main(argv, h);
  return { code, text: h.io.text(), io: h.io };
}

/** The one backup zip in `dir`, opened and checked against its manifest. */
async function backupIn(dir: string) {
  const [name] = readdirSync(dir);
  return { name, path: join(dir, name), ...(await openBundle(readFileSync(join(dir, name)))) };
}

const APP = random(300 * 1024 + 17);
const DSP = random(180 * 1024);
const C62_ZIP = fileOf('c62-build.zip', zipSync({ 'zephyr.bin': APP, 'dsp_firmware.bin': DSP }));
const MOD17_BIN = fileOf('openrtx_mod17_test.bin', random(150 * 1024));
const RT4D_BIN = fileOf('openrtx_rt4d_test.bin', random(100 * 1024));
/** An image with the vectors of a CS7000-M17 Plus build whose code starts at `base`. */
function cs7000pImage(base: number): Uint8Array {
  const image = random(50 * 1024 + 3);
  new DataView(image.buffer).setUint32(0, 0x24000200, true);
  new DataView(image.buffer).setUint32(4, base + 0x1301d, true);
  return image;
}
const CS7000P_DFU = fileOf('openrtx_cs7000p_test.dfu', buildDfuFile(0x08100000, cs7000pImage(0x08100000)));
const CS7000P_LOW_DFU = fileOf('openrtx_cs7000p_low.dfu', buildDfuFile(0x08000000, cs7000pImage(0x08000000)));
const GD77_SGL = fileOf('openrtx_gd77_test.sgl', buildSgl(random(40 * 1024), 'GD-77'));
const WRITTEN = 'Simulator: the simulated radio holds exactly what was written.';
const READ = 'Simulator: the backup holds exactly what the simulated radio held';

afterAll(removeFolders);

describe('looking around', () => {
  it('lists every radio of the catalogue and says none was checked with this tool', async () => {
    const { code, text } = await run(['radios']);
    expect(code).toBe(0);
    for (const radio of RADIOS) expect(text).toContain(`  ${radio.id.padEnd(9)} ${radio.name}`);
    expect(text).toContain('Read or flashed with this tool on real hardware so far: cs7000p.');
  });

  it('says what one radio needs: its second image, its flashing mode, its backup', async () => {
    const { code, text } = await run(['radios', 'C62']);
    expect(code).toBe(0);
    expect(text).toContain(
      'Also needs dsp_firmware.bin from the same build: the DSP image, written at 0x100000',
    );
    expect(text).toContain('2. Hold the secondary PTT');
    expect(text).toContain('Backup: read in flashing mode, about ten minutes; can be flashed back.');
    expect(text).toContain('this tool has not been checked on a real one; the web page was (2026-11-21)');
    expect(text).not.toContain('{file}');
    expect((await run(['radios', 'rt4d'])).text).toContain('a best guess');
  });

  it('gives the CS7000-M17 Plus the flashing mode the command line can reach, and no backup', async () => {
    const { text } = await run(['radios', 'cs7000p']);
    expect(text).toContain('2. Hold PTT and the orange button on top, then turn the radio on.');
    expect(text).not.toContain('SK1');
    expect(text).toContain('Backup: A radio with its Connect Systems firmware cannot be backed up');
    expect(text).toContain('this tool was checked on a real one (2026-11-24); nor has the web page');
    expect((await run(['radios'])).text).toContain('USB; backup: not possible');
    const backup = await run(['backup', 'cs7000p', '--sim']);
    expect(backup.code).toBe(1);
    expect(backup.text).toContain('cannot be backed up');
  });

  it('answers a mistake with what to do, and an exit code that says which kind', async () => {
    expect(await run(['flsh'])).toMatchObject({ code: 2 });
    const unknown = await run(['backup', 'md380']);
    expect(unknown.code).toBe(1);
    expect(unknown.text).toBe('There is no radio "md380". "openrtx-flasher radios" lists them.');
    expect((await run(['--help'])).text).toContain('openrtx-flasher flash <radio> <firmware>');
    expect((await run(['--version'])).text).toMatch(/^openrtx-flasher, build \w+$/);
  });

  it('lists the serial ports without opening one', async () => {
    const serial = serialOver(new SimRt4d(), [{ path: '/dev/ttyUSB0', manufacturer: 'Prolific' }]);
    const modules: NodeModules = {
      usb: untouchable,
      hid: untouchable,
      serial: () => Promise.resolve(serial),
    };
    const { code, text } = await run(['ports'], { modules });
    expect(code).toBe(0);
    expect(text).toBe('/dev/ttyUSB0, Prolific');
    expect(serial.constructed).toEqual([]);
    expect((await run(['ports', '--sim'])).text).toBe('A simulated radio needs no port.');
  });
});

describe('simulated radios (--sim)', () => {
  it('backs up, flashes and restores a USB radio', async () => {
    const out = folder();
    const backup = await run(['backup', 'mod17', '--sim', '--out', out]);
    expect(backup.code).toBe(0);
    expect(backup.text).toContain(
      'Simulator: this goes to a simulated radio. Nothing is sent to real hardware.',
    );
    expect(backup.text).toContain(READ);
    const saved = await backupIn(out);
    expect(saved.name).toBe('backup_mod17_sim0001_20261121-0605.zip');
    expect(saved.manifest).toMatchObject({ radio: 'mod17', radioId: 'SIM0001', source: 'flashing-mode' });
    expect(saved.parts[0]).toMatchObject({ file: 'internal-flash.bin', address: 0x08000000, complete: true });
    expect(saved.parts[0].data.length).toBe(1024 * 1024);

    const flash = await run(['flash', 'mod17', MOD17_BIN, '--sim', '--yes']);
    expect(flash.code).toBe(0);
    expect(flash.text).toContain(`SHA-256 ${sha256(readFileSync(MOD17_BIN))}`);
    expect(flash.text).toContain('Wrote and verified 153600 bytes.');
    expect(flash.text).toContain('Done. Press reset');
    expect(flash.text).toContain(WRITTEN);

    const restore = await run(['flash', 'mod17', saved.path, '--sim', '--yes']);
    expect(restore.code).toBe(0);
    expect(restore.text).toContain('This is a backup. Only restore it onto the radio it came from.');
    expect(restore.text).toContain('Wrote and verified 1048576 bytes.');
    expect(restore.text).toContain(WRITTEN);
  });

  it('backs up and flashes a serial radio', async () => {
    const out = folder();
    const backup = await run(['backup', 'rt4d', '--sim', '--out', out]);
    expect(backup.code).toBe(0);
    expect(backup.text).toContain('The radio must be in normal mode');
    expect(backup.text).toContain(READ);
    const saved = await backupIn(out);
    expect(saved.manifest).toMatchObject({ radio: 'rt4d', source: 'original-firmware' });
    expect(saved.parts[0].data.length).toBe(4 * 1024 * 1024);

    const flash = await run(['flash', 'rt4d', RT4D_BIN, '--sim', '--yes']);
    expect(flash.code).toBe(0);
    expect(flash.text).toContain('Radio is in flashing mode');
    expect(flash.text).toContain(WRITTEN);

    // That backup is a record: the tool says so instead of writing it anywhere.
    const restore = await run(['flash', 'rt4d', saved.path, '--sim', '--yes']);
    expect(restore.code).toBe(1);
    expect(restore.text).toContain('cannot be written back');
  });

  it('backs up a C62, writes both of its images in one run, and restores it', async () => {
    const out = folder();
    const backup = await run(['backup', 'c62', '--sim', '--out', out]);
    expect(backup.code).toBe(0);
    expect(backup.text).toContain('chip-id: C620240900065701');
    expect(backup.text).toContain('Put the radio in flashing mode again before you flash it.');
    expect(backup.text).toContain(READ);
    const saved = await backupIn(out);
    expect(saved.manifest).toMatchObject({ radio: 'c62', radioId: 'C620240900065701', idKind: 'chip-id' });

    const flash = await run(['flash', 'c62', C62_ZIP, '--sim', '--yes']);
    expect(flash.code).toBe(0);
    expect(flash.text).toContain(`zephyr.bin, 300 KB, SHA-256 ${sha256(APP)}`);
    expect(flash.text).toContain(
      'dsp_firmware.bin, 180 KB: the DSP image, written at 0x100000 in the same run',
    );
    expect(flash.text).toContain('Burning partition 1/2... (0x00100000');
    expect(flash.text).toContain('Burning partition 2/2... (0x00000000');
    expect(flash.text).toContain(WRITTEN);

    const restore = await run(['flash', 'c62', saved.path, '--sim', '--yes']);
    expect(restore.code).toBe(0);
    expect(restore.text).toContain('Burning partition 1/1');
    expect(restore.text).toContain(WRITTEN);
  }, 60_000);

  it('warns about a C62 build without its DSP image, and still writes it', async () => {
    const { code, text } = await run(['flash', 'c62', fileOf('zephyr.bin', APP), '--sim', '--yes']);
    expect(code).toBe(0);
    expect(text).toContain('This build has no dsp_firmware.bin.');
    expect(text).toContain('without it the radio starts with a black screen');
    expect(text).toContain(WRITTEN);
  }, 30_000);

  it('flashes a CS7000-M17 Plus in robot mode from the .dfu file of a build', async () => {
    const flash = await run(['flash', 'cs7000p', CS7000P_DFU, '--sim', '--yes']);
    expect(flash.code).toBe(0);
    expect(flash.text).toContain('Hold PTT and the orange button on top');
    expect(flash.text).toContain('Writing 51203 bytes to the second firmware slot in 26 blocks.');
    expect(flash.text).toContain('The radio took all 26 blocks.');
    expect(flash.text).toContain('Hold SK3 while turning it on to start OpenRTX');
    expect(flash.text).toContain(WRITTEN);

    const low = await run(['flash', 'cs7000p', CS7000P_LOW_DFU, '--sim', '--yes']);
    expect(low.code).toBe(1);
    expect(low.text).toContain(
      'This firmware is not built for the radio’s second firmware slot'.replace('’', "'"),
    );
    expect(low.text).toContain('Nothing was sent to the radio.');

    const dead = await run(['flash', 'cs7000p', CS7000P_DFU, '--sim=fail', '--yes']);
    expect(dead.code).toBe(1);
    expect(dead.text).toContain('Failed: Could not open the USB device: The simulated radio did not answer.');
  });

  it('flashes a HID radio and reads one', async () => {
    const flash = await run(['flash', 'gd77', GD77_SGL, '--sim', '--yes']);
    expect(flash.code).toBe(0);
    expect(flash.text).toContain(WRITTEN);
    const out = folder();
    const backup = await run(['backup', 'gd77', '--sim', '--out', out]);
    expect(backup.code).toBe(0);
    expect(backup.text).toContain(READ);
    expect((await backupIn(out)).manifest.firmware).toBe('MD-760P V311');
  });

  it('asks before it writes, and writes nothing without a yes', async () => {
    const silent = await run(['flash', 'mod17', MOD17_BIN, '--sim']);
    expect(silent.code).toBe(1);
    expect(silent.text).toContain(
      'Stopped: add --yes to write without being asked. Nothing was sent to the radio.',
    );
    expect(silent.text).not.toContain('Flashing');

    const no = await run(['flash', 'mod17', MOD17_BIN, '--sim'], {}, [false]);
    expect(no.code).toBe(1);
    expect(no.io.asked).toEqual(['Write openrtx_mod17_test.bin to the Module 17 now?']);
    expect(no.text).toContain('Stopped. Nothing was sent to the radio.');

    const yes = await run(['flash', 'mod17', MOD17_BIN, '--sim'], {}, [true]);
    expect(yes.code).toBe(0);
    expect(yes.text).toContain(WRITTEN);
  });

  it('writes nothing when the file is for another radio', async () => {
    const wrong = await run(['flash', 'gd77', MOD17_BIN, '--sim', '--yes']);
    expect(wrong.code).toBe(1);
    expect(wrong.text).toBe(
      'openrtx_mod17_test.bin has no firmware for the Radioddity GD-77. Its file is called openrtx_gd77_<version>.sgl.',
    );

    const out = folder();
    await run(['backup', 'mod17', '--sim', '--out', out]);
    const other = await run(['flash', 'cs7000', (await backupIn(out)).path, '--sim', '--yes']);
    expect(other.code).toBe(1);
    expect(other.text).toBe('This backup is of a Module 17, not a Connect Systems CS7000-M17.');
  });

  it('does not restore a backup onto a radio that says it is another one', async () => {
    const out = folder();
    await run(['backup', 'mod17', '--sim', '--out', out]);
    const mine = await backupIn(out);
    // The same backup, as if it had been taken from another Module 17.
    const theirs = await makeBundle(
      { id: 'mod17', name: 'Module 17' },
      { radioId: '3052345A3133', idKind: 'usb-serial', notes: [], parts: mine.parts },
      'flashing-mode',
      new Date(mine.manifest.taken),
    );
    const refused = await run(['flash', 'mod17', fileOf(theirs.name, theirs.zip), '--sim', '--yes']);
    expect(refused.code).toBe(1);
    expect(refused.text).toContain(
      'This backup is of another radio (ID ending 345A3133); the one connected ends SIM0001. Nothing was sent to it.',
    );
    expect(refused.text).not.toContain('Flashing');
  });

  it('fails in the page’s words when the radio does not answer or cannot be read', async () => {
    const dead = await run(['flash', 'mod17', MOD17_BIN, '--sim=fail', '--yes']);
    expect(dead.code).toBe(1);
    expect(dead.text).toContain('Failed: Could not open the USB device: The simulated radio did not answer.');
    expect(dead.text).toContain('Put the radio back in flashing mode and try again.');
    // A simulated failure is not something to report.
    expect(dead.text).not.toContain('To report this');

    const out = folder();
    const locked = await run(['backup', 'cs7000', '--sim=protected', '--out', out]);
    expect(locked.code).toBe(1);
    expect(locked.text).toContain('Its chip is probably read-protected');
    expect(existsSync(out) ? readdirSync(out) : []).toEqual([]);

    const wrong = await run(['backup', 'md9600', '--sim=wrongmode', '--out', out]);
    expect(wrong.code).toBe(1);
    expect(wrong.text).toContain('Check that the radio is in normal mode and try again.');
  });

  it.skipIf(!process.env.ORTX_RELEASE_DIR)('refuses a TYT radio that is not in flashing mode', async () => {
    const firmware = join(process.env.ORTX_RELEASE_DIR!, 'openrtx_md3x0_v0.4.5.bin');
    const refused = await run(['flash', 'md3x0', firmware, '--sim=wrongmode', '--yes']);
    expect(refused.code).toBe(1);
    expect(refused.text).toContain(
      'Failed: The radio is not in flashing mode: it is in normal mode. Nothing was sent to it.',
    );
    const done = await run(['flash', 'md3x0', firmware, '--sim', '--yes']);
    expect(done.code).toBe(0);
    expect(done.text).toContain('This bootloader cannot read the flash back, so the write was not verified.');
    expect(done.text).toContain(WRITTEN);
  });

  it('tells how a radio that is flashed by copying a file is done', async () => {
    const { code, text } = await run(['flash', 'ttwrplus', 'release', '--sim', '--yes']);
    expect(code).toBe(1);
    expect(text).toContain('is flashed by copying a file onto its USB drive');
    expect(text).toContain('openrtx-flasher fetch ttwrplus release');
    expect((await run(['backup', 'ttwrplus'])).text).toContain('CURRENT.UF2');
  });
});

describe('real hardware, stood in for by fakes', () => {
  it('does not talk to a radio nobody has checked this tool on unless told to', async () => {
    const stopped = await run(['flash', 'c62', C62_ZIP, '--yes']);
    expect(stopped.code).toBe(1);
    expect(stopped.text).toContain(
      'Nobody has checked this command-line tool against a real Retevis C62 / C2 yet.',
    );
    // The page was checked on a C62; that is about the page.
    expect(stopped.text).toContain(
      'The web page was checked on one; this tool reaches the radio another way.',
    );
    expect(stopped.text).toContain('Stopped: add --experimental to go on. Nothing was sent to the radio.');

    const refused = await run(['backup', 'mod17'], {}, [false]);
    expect(refused.code).toBe(1);
    expect(refused.io.asked).toEqual(['I can recover my radio: go on?']);
    expect(refused.text).toContain('Stopped. Nothing was sent to the radio.');
    // Neither run got as far as the `untouchable` packages.
    expect(stopped.text + refused.text).not.toContain('real device');
  });

  it('flashes a GD-77 through node-hid and asks how it went', async () => {
    const sim = new SimGd77({ model: 'GD-77' });
    const modules: NodeModules = {
      usb: untouchable,
      serial: untouchable,
      hid: () => Promise.resolve(hidOver(sim)),
    };
    const { code, text, io } = await run(['flash', 'gd77', GD77_SGL], { modules }, [true, true]);
    expect(code).toBe(0);
    expect(io.asked).toEqual([
      'I can recover my radio: go on?',
      'Write openrtx_gd77_test.sgl to the Radioddity GD-77 now?',
    ]);
    expect(sim.errors).toEqual([]);
    expect(sim.complete).toBe(true);
    expect(Buffer.compare(sim.payload, parseSgl(readFileSync(GD77_SGL)).payload)).toBe(0);
    expect(text).not.toContain('Simulator');
    expect(text).toContain('Done. Turn the radio off and on again.');
    // Nobody has reported this tool on this radio: it asks, with links that send nothing by themselves.
    expect(text).toContain('Did the radio start OpenRTX?');
    expect(text).toMatch(/Yes: https:\/\/\S+\/issues\/new\?title=Worked%3A%20Radioddity%20GD-77/);
    expect(text).toMatch(/No: {2}https:\/\/\S+title=Failed%3A%20Radioddity%20GD-77%2C%20flash/);
    expect(text).toContain(encodeURIComponent('openrtx-flasher command line, Node'));
  });

  it('reports a failed flash with a link to a filled-in report at the address it is told', async () => {
    const sim = new SimGd77({ model: 'DM-1801' });
    const modules: NodeModules = {
      usb: untouchable,
      serial: untouchable,
      hid: () => Promise.resolve(hidOver(sim)),
    };
    const env = { FEEDBACK_URL: 'https://forge.example/owner/repo/issues/new' };
    const { code, text } = await run(['flash', 'gd77', GD77_SGL, '--yes', '--experimental'], {
      modules,
      env,
    });
    expect(code).toBe(1);
    expect(text).toContain('Failed: ');
    expect(text).toContain('To report this: https://forge.example/owner/repo/issues/new?title=Failed');
  });

  it('writes both C62 images with the cskburn it is given, on the port it is given', async () => {
    const dir = folder();
    const serial = serialOver(new SimRt4d());
    const modules: NodeModules = {
      usb: untouchable,
      hid: untouchable,
      serial: () => Promise.resolve(serial),
    };
    const argv = ['flash', 'c62', C62_ZIP, '--yes', '--experimental', '--port', '/dev/tty.fake'];
    const { code, text } = await run([...argv, '--cskburn', standInCskburn(dir)], { modules });
    expect(code).toBe(0);
    const record = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8')) as CskburnRecord;
    expect(record.args.slice(2, 4)).toEqual(['-s', '/dev/tty.fake']);
    expect(record.args.slice(-5)).toEqual(['--verify-all', '0x100000', 'part0.bin', '0x0', 'part1.bin']);
    expect(record.parts).toEqual({ '0x100000': sha256(DSP), '0x0': sha256(APP) });
    expect(text).toContain('Burning partition 2/2');
    expect(text).toContain('Done. Turn the radio off and on again.');
    // cskburn opens the port itself: the tool's own serial layer must leave it alone.
    expect(serial.constructed).toEqual([]);
  });

  it('uses the pinned cskburn when none is named, and says so when there is none for this computer', async () => {
    const dir = folder();
    const out = folder();
    const serial = serialOver(new SimRt4d());
    const modules: NodeModules = {
      usb: untouchable,
      hid: untouchable,
      serial: () => Promise.resolve(serial),
    };
    const argv = ['backup', 'c62', '--experimental', '--port', 'COM7', '--out', out];
    const pinned = standInCskburn(dir);
    const { code, text } = await run(argv, { modules, cskburn: () => Promise.resolve(pinned) });
    expect(code).toBe(0);
    const saved = await backupIn(out);
    expect(saved.manifest).toMatchObject({
      radio: 'c62',
      radioId: STAND_IN_CHIP_ID,
      source: 'flashing-mode',
    });
    // The real radio is read whole: 4 MiB.
    expect(saved.parts[0].data.length).toBe(4 * 1024 * 1024);
    expect(Array.from(saved.parts[0].data.subarray(0, 3))).toEqual([0, 7, 14]);
    expect(text).toContain(`Saved ${saved.path} (4.0 MB).`);
    expect(text).not.toContain('Simulator');

    const none = await run(argv, { modules });
    expect(none.code).toBe(1);
    expect(none.text).toContain('There is no ready-made cskburn for this computer');
    expect(none.text).toContain('--cskburn');
  });

  it('gives the page’s message when the C62 is not in flashing mode', async () => {
    const serial = serialOver(new SimRt4d());
    const modules: NodeModules = {
      usb: untouchable,
      hid: untouchable,
      serial: () => Promise.resolve(serial),
    };
    const silent = standInCskburn(folder(), true);
    const argv = [
      'flash',
      'c62',
      C62_ZIP,
      '--yes',
      '--experimental',
      '--port',
      '/dev/fake',
      '--cskburn',
      silent,
    ];
    const { code, text } = await run(argv, { modules });
    expect(code).toBe(1);
    expect(text).toContain('Failed: The radio did not answer. Put it in flashing mode');
    expect(text).toContain('To report this: https://');
  });

  it('wants the serial port named when it cannot ask', async () => {
    const serial = serialOver(new SimRt4d(), [{ path: '/dev/ttyUSB0' }, { path: '/dev/ttyUSB1' }]);
    const modules: NodeModules = {
      usb: untouchable,
      hid: untouchable,
      serial: () => Promise.resolve(serial),
    };
    const { code, text } = await run(['flash', 'rt4d', RT4D_BIN, '--yes', '--experimental'], { modules });
    expect(code).toBe(1);
    expect(text).toContain('Say which serial port the radio is on with --port.');
    // No radio was reached, so there is no failed flash to put right or to report.
    expect(text).not.toContain('Failed');
    expect(text).not.toContain('To report this');
    expect(serial.constructed).toEqual([]);
  });

  it('flashes an RT-4D through serialport on the port picked from the list', async () => {
    const sim = new SimRt4d();
    const serial = serialOver(sim, [{ path: '/dev/ttyUSB0' }, { path: '/dev/ttyUSB1' }]);
    const modules: NodeModules = {
      usb: untouchable,
      hid: untouchable,
      serial: () => Promise.resolve(serial),
    };
    const { code } = await run(['flash', 'rt4d', RT4D_BIN, '--experimental'], { modules }, [true, 1]);
    expect(code).toBe(0);
    expect(sim.complete).toBe(true);
    expect(serial.constructed).toEqual([{ path: '/dev/ttyUSB1', baudRate: 115200 }]);
  });
});

/** A backup with one part, for the stand-in reader below. */
const EMPTY = {
  idKind: 'usb-serial' as const,
  notes: [],
  parts: [
    {
      file: 'internal-flash.bin',
      kind: 'internal-flash' as const,
      address: 0x08000000,
      data: random(64),
      complete: true,
    },
  ],
};

describe('a radio that is already backed up', () => {
  it('is not read again once the reader recognises it, unless --again says so', async () => {
    const out = folder();
    await run(['backup', 'mod17', '--sim', '--out', out]);
    const first = await backupIn(out);

    // The reader the page is about to have: it asks whether the radio is known before the long read.
    const asked: boolean[] = [];
    const readBackup: Host['readBackup'] = (_radio, _picked, _ctx, _size, known) => {
      asked.push(known!('SIM0001'), known!('SOMEONE-ELSE'));
      return Promise.resolve(known!('SIM0001') ? { known: 'SIM0001' } : { ...EMPTY, radioId: 'SIM0001' });
    };
    const again = await run(['backup', 'mod17', '--sim', '--out', out], { readBackup });
    expect(again.code).toBe(0);
    expect(asked).toEqual([true, false]);
    expect(again.text).toContain(
      `This radio (ID ending SIM0001) already has a backup in ${out}: ${first.name}. Nothing more was read.`,
    );
    expect(readdirSync(out)).toEqual([first.name]);

    const forced = await run(['backup', 'mod17', '--sim', '--out', out, '--again'], { readBackup });
    expect(asked.slice(2)).toEqual([false, false]);
    // The stand-in reader made its bytes up, and the simulator check notices.
    expect(forced.code).toBe(1);
    expect(forced.text).toContain('Simulator: the backup differs from what the simulated radio held.');
    // A second file beside the first: nothing is replaced.
    expect(readdirSync(out).sort()).toEqual([first.name.replace('.zip', '-2.zip'), first.name].sort());
  });
});
