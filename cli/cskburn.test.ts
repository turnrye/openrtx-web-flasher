// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { backupCsk, flashCsk, readCskChipId } from '../src/flash/csk.ts';
import { quietContext, type Progress } from '../src/flash/types.ts';
import { SimCsk6 } from '../src/sim/csk6.ts';
import { md5 } from '../src/sim/md5.ts';
import { CSKBURN_PIN, nativeCskburn, pinnedCskburn, wasmCskburn, type ToolPin } from './cskburn.ts';
import {
  folder,
  removeFolders,
  standInCskburn,
  STAND_IN_CHIP_ID,
  type CskburnRecord,
} from './test-support.ts';

/** SHA-256 of `bytes` as hex. */
function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** What the stand-in cskburn in `dir` wrote down about its last run. */
function recordIn(dir: string): CskburnRecord {
  return JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8')) as CskburnRecord;
}

/** The port object csk.ts is given; the native program opens the port itself, so nothing may touch it. */
const untouched = {} as SerialPort;

afterAll(removeFolders);

describe('the pinned cskburn release', () => {
  it('pins the release of the commit the page’s WebAssembly build is made from', () => {
    const pins = JSON.parse(readFileSync(new URL('../vendor.json', import.meta.url), 'utf8')) as {
      cskburn: { commit: string };
    };
    // v1.32.0-alpha.5 is the tag on that commit; moving one pin without the other is a mistake.
    expect(pins.cskburn.commit).toBe('e00ec448225387c8a0788f93e86d0f8c9e7b3819');
    expect(CSKBURN_PIN.version).toBe('v1.32.0-alpha.5');
    for (const [platform, build] of Object.entries(CSKBURN_PIN.builds)) {
      expect(build!.url, platform).toContain(`/releases/download/${CSKBURN_PIN.version}/cskburn-`);
      expect(build!.sha256, platform).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(Object.keys(CSKBURN_PIN.builds).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-x64',
    ]);
  });

  it('downloads once, checks the archive and unpacks only the program', async () => {
    const program = strToU8('MZ pretend program');
    const archive = zipSync({ 'cskburn.exe': program, 'evil/../../other.exe': strToU8('no') });
    const pin: ToolPin = {
      version: 'v9',
      builds: { 'win32-x64': { url: 'https://example.invalid/cskburn.zip', sha256: sha256(archive) } },
    };
    const cache = folder();
    let downloads = 0;
    /** Hands out the archive and counts how often it was asked for. */
    const get = () => {
      downloads++;
      return Promise.resolve(archive);
    };
    const path = await pinnedCskburn(pin, 'win32-x64', cache, get);
    expect(path).toBe(join(cache, 'tools', 'cskburn-v9-win32-x64', 'cskburn.exe'));
    expect(Buffer.compare(readFileSync(path!), program)).toBe(0);
    expect(statSync(path!).mode & 0o111).not.toBe(0);
    expect(existsSync(join(cache, 'tools', 'other.exe'))).toBe(false);

    expect(await pinnedCskburn(pin, 'win32-x64', cache, get)).toBe(path);
    expect(downloads).toBe(1);
  });

  it('refuses an archive that does not match its checksum and keeps nothing of it', async () => {
    const archive = zipSync({ 'cskburn.exe': strToU8('tampered') });
    const pin: ToolPin = {
      version: 'v9',
      builds: { 'win32-x64': { url: 'https://example.invalid/cskburn.zip', sha256: '0'.repeat(64) } },
    };
    const cache = folder();
    await expect(pinnedCskburn(pin, 'win32-x64', cache, () => Promise.resolve(archive))).rejects.toThrow(
      'does not match its checksum',
    );
    expect(existsSync(join(cache, 'tools'))).toBe(false);
  });

  it('says so when the download fails', async () => {
    /** A download on a computer that is offline. */
    const offline = () => Promise.reject(new Error('fetch failed'));
    await expect(pinnedCskburn(CSKBURN_PIN, 'linux-x64', folder(), offline)).rejects.toThrow(
      'Could not download cskburn (fetch failed). Check your connection, or name a cskburn you already have with --cskburn.',
    );
  });

  it('has nothing for a computer no build is pinned for', async () => {
    /** A download that must not happen. */
    const never = () => Promise.reject(new Error('must not download'));
    expect(await pinnedCskburn(CSKBURN_PIN, 'sunos-sparc', folder(), never)).toBeNull();
  });

  it('says so when the archive does not hold the program', async () => {
    const archive = zipSync({ 'readme.txt': strToU8('hello') });
    const pin: ToolPin = {
      version: 'v9',
      builds: { 'win32-x64': { url: 'https://example.invalid/cskburn.zip', sha256: sha256(archive) } },
    };
    await expect(pinnedCskburn(pin, 'win32-x64', folder(), () => Promise.resolve(archive))).rejects.toThrow(
      'Could not unpack the cskburn download.',
    );
  });
});

describe('a native cskburn in the place of the WebAssembly module', () => {
  it('writes both C62 images through the page’s flasher', async () => {
    const dir = folder();
    const options = { loadModule: nativeCskburn(standInCskburn(dir), '/dev/tty.fake-1') };
    const app = new Uint8Array(randomBytes(300 * 1024 + 5));
    const dsp = new Uint8Array(randomBytes(180 * 1024));
    const seen: Progress[] = [];
    const log: string[] = [];
    await flashCsk(
      untouched,
      [
        { address: 0x100000, data: dsp },
        { address: 0, data: app },
      ],
      quietContext({ progress: (p) => seen.push(p), log: (line) => log.push(line) }),
      options,
    );
    const record = recordIn(dir);
    // What csk.ts asks the WebAssembly cskburn for, with the real port and files beside the program.
    expect(record.args).toEqual([
      '-C',
      '6',
      '-s',
      '/dev/tty.fake-1',
      '-b',
      '115200',
      '--probe-timeout',
      '4000',
      '--reset-attempts',
      '0',
      '--verify-all',
      '0x100000',
      'part0.bin',
      '0x0',
      'part1.bin',
    ]);
    expect(record.parts).toEqual({ '0x100000': sha256(dsp), '0x0': sha256(app) });
    expect(log).toContain('Finished');
    expect(seen.at(-1)).toEqual({
      phase: 'done',
      done: app.length + dsp.length,
      total: app.length + dsp.length,
    });
    expect(seen.some((p) => p.phase === 'write' && p.done === dsp.length)).toBe(true);
  });

  it('reads a backup and the chip ID through the page’s reader', async () => {
    const dir = folder();
    const options = { loadModule: nativeCskburn(standInCskburn(dir), 'COM7') };
    const { data, chipId } = await backupCsk(untouched, 96 * 1024, quietContext(), options);
    expect(chipId).toBe(STAND_IN_CHIP_ID);
    expect(data.length).toBe(96 * 1024);
    expect(Array.from(data.subarray(0, 4))).toEqual([0, 7, 14, 21]);
    // The file name carries no folder, so a Windows path brings no extra colon into the read spec.
    expect(recordIn(dir).args.slice(-4)).toEqual([
      '--chip-id',
      '--verify-all',
      '--read',
      '0x0:0x18000:read.bin',
    ]);
    expect(recordIn(dir).args[3]).toBe('COM7');
    expect(await readCskChipId(untouched, quietContext(), options)).toBe(STAND_IN_CHIP_ID);
  });

  it('ends the program when a read is stopped because the radio is already backed up', async () => {
    const dir = folder();
    const options = { loadModule: nativeCskburn(standInCskburn(dir, false, true), '/dev/fake') };
    const read = await backupCsk(untouched, 96 * 1024, quietContext(), options, () => true);
    expect(read).toEqual({ known: STAND_IN_CHIP_ID });
    // The stand-in would go on for a minute; it is gone well before that.
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 });
  });

  it('turns a radio that is not in flashing mode into the page’s message', async () => {
    const options = { loadModule: nativeCskburn(standInCskburn(folder(), true), '/dev/fake') };
    await expect(
      flashCsk(untouched, [{ address: 0, data: new Uint8Array(16) }], quietContext(), options),
    ).rejects.toThrow('The radio did not answer. Put it in flashing mode');
  });

  it('says so when the program cannot be run', async () => {
    const options = { loadModule: nativeCskburn(join(folder(), 'not-there'), '/dev/fake') };
    const log: string[] = [];
    await expect(
      readCskChipId(untouched, quietContext({ log: (line) => log.push(line) }), options),
    ).rejects.toThrow();
    expect(log.join('\n')).toContain('could not run');
  });
});

describe('the WebAssembly cskburn for the simulated C62', () => {
  it('is the build `npm run vendor` put in this checkout, and runs against the simulator', async () => {
    const sim = new SimCsk6({ md5, flashSize: 256 * 1024 });
    const app = new Uint8Array(randomBytes(20 * 1024));
    await flashCsk(sim as unknown as SerialPort, [{ address: 0, data: app }], quietContext(), {
      loadModule: wasmCskburn(),
    });
    expect(Buffer.compare(sim.flash.subarray(0, app.length), app)).toBe(0);
  });

  it('says how to get one where there is none', async () => {
    const empty = folder();
    await expect(wasmCskburn(empty, empty)()).rejects.toThrow('"npm run vendor" builds it');
  });
});
