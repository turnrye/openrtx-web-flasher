// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeBundle } from '../backup/bundle.ts';
import { isAlready } from '../backup/types.ts';
import { markSimulated } from '../devices.ts';
import { radioById } from '../radios.ts';
import { SimCsk6 } from '../sim/csk6.ts';
import { SimRt950Stock } from '../sim/rt950-stock.ts';
import { md5 } from '../sim/md5.ts';
import { SimStm32Dfu } from '../sim/stm32dfu.ts';
import type { CskModuleLoader } from './csk.ts';
import {
  backupDevice,
  flashDevice,
  restoreRefusal,
  setCskburnLoader,
  SIMULATED_BACKUP,
  type BackupOrigin,
  type PickedDevice,
} from './run.ts';
import { quietContext, WrongRadioError } from './types.ts';

const MOD17 = radioById('mod17')!;
const CS7000P = radioById('cs7000p')!;
const RT950 = radioById('rt950pro')!;
const C62 = radioById('c62')!;

/** A simulated Module 17 in flashing mode, as the device a person picked. Its USB serial number is SIM0001. */
function mod17(): { sim: SimStm32Dfu; picked: PickedDevice } {
  const sim = new SimStm32Dfu({ chip: 'f405' });
  return { sim, picked: { api: 'usb', device: sim } };
}

/** A simulated C62 in flashing mode, as the port a person picked. */
function c62(chipId?: Uint8Array): { sim: SimCsk6; picked: PickedDevice } {
  const sim = new SimCsk6({ md5, flashSize: 256 * 1024, chipId });
  return { sim, picked: { api: 'serial', device: sim as unknown as SerialPort } };
}

describe('writing a backup back', () => {
  const image = new Uint8Array(randomBytes(8 * 1024));

  it('refuses the backup of another STM32 radio before anything is sent', async () => {
    const { sim, picked } = mod17();
    const origin: BackupOrigin = { radioId: '3052345A3133', idKind: 'usb-serial' };
    const attempt = flashDevice(MOD17, picked, image, quietContext({ sleep: sim.sleep }), origin);
    await expect(attempt).rejects.toBeInstanceOf(WrongRadioError);
    await expect(attempt).rejects.toThrow(
      'This backup is of another radio (ID ending 345A3133); the one connected ends SIM0001. Nothing was sent to it.',
    );
    expect(sim.requests).toEqual([]);
    expect(sim.opened).toBe(false);
  });

  it('writes the backup of the radio that is connected', async () => {
    const { sim, picked } = mod17();
    const origin: BackupOrigin = { radioId: 'SIM0001', idKind: 'usb-serial' };
    expect(restoreRefusal(origin, picked)).toBeNull();
    await flashDevice(MOD17, picked, image, quietContext({ sleep: sim.sleep }), origin);
    expect(Buffer.compare(sim.read(0x08000000, image.length), image)).toBe(0);
  });

  it('never writes the backup of a simulated radio to a real one', async () => {
    const { sim, picked } = mod17();
    const origin: BackupOrigin = { radioId: 'SIM0001', idKind: 'usb-serial', simulated: true };
    // The simulator stands for a real radio here: the simulated environment did not hand it out.
    const attempt = flashDevice(MOD17, picked, image, quietContext({ sleep: sim.sleep }), origin);
    await expect(attempt).rejects.toBeInstanceOf(WrongRadioError);
    await expect(attempt).rejects.toThrow(SIMULATED_BACKUP);
    expect(sim.requests).toEqual([]);

    // Under the simulator it is the way to try a restore.
    markSimulated(sim);
    expect(restoreRefusal(origin, picked)).toBeNull();
    await flashDevice(MOD17, picked, image, quietContext({ sleep: sim.sleep }), origin);
    expect(Buffer.compare(sim.read(0x08000000, image.length), image)).toBe(0);
  });

  describe('to a C62', () => {
    const cskburn: CskModuleLoader = async () => (await import('../../public/cskburn/cskburn.mjs')).default;
    // The page's own loader needs a document to load cskburn next to.
    beforeAll(() => setCskburnLoader(cskburn));

    it('asks the chip for its ID first and writes when it is the one in the backup', async () => {
      const { sim, picked } = c62();
      const origin: BackupOrigin = { radioId: 'C620240900065701', idKind: 'chip-id' };
      await flashDevice(C62, picked, image, quietContext(), origin);
      expect(Buffer.compare(sim.flash.subarray(0, image.length), image)).toBe(0);
      expect(sim.trace.join(', ')).toMatch(/CHIP_ID x1, FLASH_ID x1, FLASH_BEGIN x1/);
    });

    it('writes nothing to a chip that is not the one in the backup', async () => {
      const { sim, picked } = c62(Uint8Array.of(0xc6, 0x20, 0x24, 0x09, 0x00, 0x06, 0x99, 0x99));
      const before = sim.flash.slice();
      const origin: BackupOrigin = { radioId: 'C620240900065701', idKind: 'chip-id' };
      const attempt = flashDevice(C62, picked, image, quietContext(), origin);
      await expect(attempt).rejects.toBeInstanceOf(WrongRadioError);
      await expect(attempt).rejects.toThrow(
        'This backup is of another radio (ID ending 00065701); the one connected ends 00069999. Nothing was written to it.',
      );
      // cskburn, cut off, gives up by itself; nothing it tries after the ID reaches the radio.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(sim.trace.at(-1)).toBe('CHIP_ID x1');
      expect(Buffer.compare(sim.flash, before)).toBe(0);
    });

    it('does not ask for the ID when firmware is written', async () => {
      const { sim, picked } = c62();
      await flashDevice(C62, picked, image, quietContext());
      expect(sim.trace.join(', ')).not.toContain('CHIP_ID');
    });
  });
});

describe('a backup of a simulated radio', () => {
  it('says that it is one, in the backup and in its manifest', async () => {
    const { sim, picked } = mod17();
    markSimulated(sim);
    const read = await backupDevice(MOD17, picked, quietContext({ sleep: sim.sleep }));
    if (isAlready(read)) throw new Error('the radio was not read');
    expect(read.simulated).toBe(true);
    const { manifest } = await makeBundle(MOD17, read, 'flashing-mode', new Date());
    expect(manifest.simulated).toBe(true);
  });

  it('is not what a backup of a real radio says', async () => {
    const { sim, picked } = mod17();
    const read = await backupDevice(MOD17, picked, quietContext({ sleep: sim.sleep }));
    if (isAlready(read)) throw new Error('the radio was not read');
    expect(read.simulated).toBeUndefined();
    const { manifest } = await makeBundle(MOD17, read, 'flashing-mode', new Date());
    expect('simulated' in manifest).toBe(false);
  });
});

describe('a radio whose ID matches a backup that exists', () => {
  /** A `known` that says yes to every radio, and what it was asked. */
  function everyRadio(): { asked: string[]; known: (id: string) => boolean } {
    const asked: string[] = [];
    return {
      asked,
      known: (id) => {
        asked.push(id);
        return true;
      },
    };
  }

  it('is not read again when the ID is known to be its own: an STM32F405 by its USB serial number', async () => {
    const { sim, picked } = mod17();
    const { asked, known } = everyRadio();
    const read = await backupDevice(MOD17, picked, quietContext({ sleep: sim.sleep }), undefined, known);
    expect(read).toEqual({ known: 'SIM0001' });
    expect(asked).toEqual(['SIM0001']);
    expect(sim.requests).toEqual([]);
  });

  it('is read all the same when it is not yet known that the ID differs between radios: an STM32H743', async () => {
    const sim = new SimStm32Dfu({ chip: 'h743' });
    const picked: PickedDevice = { api: 'usb', device: sim };
    const { asked, known } = everyRadio();
    const read = await backupDevice(CS7000P, picked, quietContext({ sleep: sim.sleep }), undefined, known);
    if (isAlready(read)) throw new Error('the read stopped on an ID that may not be the radio’s own');
    expect(asked).toEqual([]);
    // The backup still says which radio it is of, to be matched with an earlier one afterwards.
    expect(read).toMatchObject({ radioId: 'SIM0001', idKind: 'usb-serial' });
    expect(read.parts[0].data.length).toBe(2 * 1024 * 1024);
  });

  it('is read all the same when the ID is a fingerprint of its calibration: an RT-950 Pro', async () => {
    const sim = new SimRt950Stock();
    const picked: PickedDevice = { api: 'serial', device: sim };
    const { asked, known } = everyRadio();
    const read = await backupDevice(RT950, picked, quietContext(), undefined, known);
    if (isAlready(read)) throw new Error('the read stopped on an ID that may not be the radio’s own');
    expect(asked).toEqual([]);
    expect(read.idKind).toBe('fingerprint');
    expect(read.radioId).toMatch(/^[0-9a-f]+$/);
    expect(read.parts[0].data.length).toBe(64 * 1024);
    expect(sim.forbidden).toEqual([]);
  });
});
