// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  checkSecondSlotImage,
  flashCs7000Robot,
  parseRobotFrame,
  ROBOT_BLOCK,
  RobotCommand,
  robotFrame,
  scramble,
  SECOND_SLOT,
} from './cs7000-robot.ts';
import { flashDevice } from './run.ts';
import { FlashError, quietContext, type Progress } from './types.ts';
import { forCommandLine, radioById } from '../radios.ts';
import { SimCs7000Robot, type SimCs7000RobotOptions, type SimIdle } from '../sim/cs7000-robot.ts';
import { buildDfuFile, SimStm32Dfu } from '../sim/stm32dfu.ts';

/** Random bytes with the vectors of an OpenRTX build for the second slot. */
function image(length: number): Uint8Array {
  const bytes = new Uint8Array(randomBytes(length));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x24000200, true);
  view.setUint32(4, SECOND_SLOT + 0x1301d, true);
  return bytes;
}

/** Flashes `firmware` into a fresh simulated radio and returns what happened. */
async function flashSim(firmware: Uint8Array, options: SimCs7000RobotOptions = {}) {
  const sim = new SimCs7000Robot(options);
  const progress: Progress[] = [];
  const logs: string[] = [];
  const ctx = quietContext({ log: (m) => logs.push(m), progress: (p) => progress.push(p) });
  let error: unknown = null;
  try {
    await flashCs7000Robot(sim as unknown as USBDevice, firmware, ctx);
  } catch (e) {
    error = e;
  }
  return { sim, progress, logs, error };
}

describe('frames of the CS7000-M17 Plus bootloader', () => {
  it('builds the connect frame the Factory Tool sends, in the clear and scrambled', () => {
    const connect = robotFrame(RobotCommand.CONNECT, Uint8Array.of(1, 2, 0xff));
    expect(Buffer.from(connect).toString('hex')).toBe('a1064c00030102ff0102a4');
    // XORed by hand with the first eleven bytes of the table: 5c 6c 6b 6a 68 67 88 65 64 62 61.
    expect(Buffer.from(scramble(connect)).toString('hex')).toBe('fd6a276a6b668a9a6560c5');
    expect(scramble(scramble(connect))).toEqual(connect);
  });

  it('starts the table over with every frame and wraps it after 256 bytes', () => {
    const zeroes = scramble(new Uint8Array(300));
    expect(zeroes.subarray(256, 300)).toEqual(zeroes.subarray(0, 44));
  });

  it('reads back what it builds and nothing that is damaged', () => {
    const payload = new Uint8Array(randomBytes(700));
    const frame = robotFrame(0x8642, payload);
    expect(parseRobotFrame(frame)).toEqual({ command: 0x8642, payload });
    expect(parseRobotFrame(robotFrame(RobotCommand.COMMIT, new Uint8Array(0)))).toEqual({
      command: RobotCommand.COMMIT,
      payload: new Uint8Array(0),
    });
    const flipped = frame.slice();
    flipped[100] ^= 1;
    expect(parseRobotFrame(flipped)).toBeNull();
    expect(parseRobotFrame(frame.subarray(0, frame.length - 1))).toBeNull();
    expect(parseRobotFrame(new Uint8Array(0))).toBeNull();
  });
});

describe('flashCs7000Robot on a simulated radio in robot mode', () => {
  const idles: SimIdle[] = ['zeroes', 'skip', 'stall', 'timeout'];
  for (const idle of idles) {
    for (const padAnswers of [true, false]) {
      it(`writes an image when an empty fetch gives ${idle} and answers are ${padAnswers ? 'filled up' : 'short'}`, async () => {
        const firmware = image(5 * ROBOT_BLOCK + 777);
        const { sim, error, progress } = await flashSim(firmware, { idle, padAnswers });
        expect(error).toBeNull();
        expect(sim.violations).toEqual([]);
        expect(sim.committed).toBe(true);
        expect(Buffer.compare(sim.image, firmware)).toBe(0);
        expect(sim.frames).toEqual([
          RobotCommand.CONNECT,
          ...Array<number>(6).fill(RobotCommand.DATA),
          RobotCommand.COMMIT,
        ]);
        expect(progress.at(-1)).toEqual({ phase: 'done', done: firmware.length, total: firmware.length });
        expect(sim.opened).toBe(false);
      });
    }
  }

  it('writes an image that fills its last block exactly', async () => {
    const firmware = image(3 * ROBOT_BLOCK);
    const { sim, error } = await flashSim(firmware);
    expect(error).toBeNull();
    expect(sim.violations).toEqual([]);
    expect(Buffer.compare(sim.image, firmware)).toBe(0);
  });

  it('sends nothing when the image is not built for the second slot', async () => {
    const lowerSlot = image(4096);
    new DataView(lowerSlot.buffer).setUint32(4, 0x0801301d, true);
    const otherStack = image(4096);
    new DataView(otherStack.buffer).setUint32(0, 0x20020000, true);
    for (const firmware of [lowerSlot, otherStack, image(0x100000 + 1), new Uint8Array(4)]) {
      const { sim, error } = await flashSim(firmware);
      expect(error).toBeInstanceOf(FlashError);
      expect(sim.opened).toBe(false);
      expect(sim.frames).toEqual([]);
    }
    expect(() => checkSecondSlotImage(lowerSlot)).toThrow(/not built for the radio's second firmware slot/);
    expect(() => checkSecondSlotImage(image(0x100000))).not.toThrow();
  });

  it('stops after the connect request when the radio does not answer it', async () => {
    const { sim, error } = await flashSim(image(3 * ROBOT_BLOCK), { silent: true });
    expect(error).toBeInstanceOf(FlashError);
    expect((error as Error).message).toBe('The radio did not answer the connect request.');
    expect(sim.frames).toEqual([RobotCommand.CONNECT]);
    expect(sim.violations).toEqual([]);
    expect(sim.opened).toBe(false);
  });

  it('goes by the answer’s command, as the Factory Tool does, and says when its contents are unusual', async () => {
    const firmware = image(4 * ROBOT_BLOCK);
    const { sim, error, logs } = await flashSim(firmware, { oddAnswerAt: 2 });
    expect(error).toBeNull();
    expect(sim.committed).toBe(true);
    expect(logs).toContain('The radio answered block 3 of 4 with 00, not the usual 21.');
  });

  it('says so when the device is not a USB drive', async () => {
    const dfu = new SimStm32Dfu({ chip: 'h743' });
    const ctx = quietContext();
    await expect(flashCs7000Robot(dfu, image(4096), ctx)).rejects.toThrow(
      'This USB device is not a USB drive. Is the radio in flashing mode?',
    );
  });
});

describe('the command line’s CS7000-M17 Plus', () => {
  const radio = forCommandLine(radioById('cs7000p')!);

  it('is flashed in robot mode with the .dfu file of a build', async () => {
    expect(radio.method).toBe('cs7000-robot');
    expect(radio.ext).toBe('dfu');
    const firmware = image(3 * ROBOT_BLOCK + 5);
    const sim = new SimCs7000Robot();
    const picked = { api: 'usb' as const, device: sim as unknown as USBDevice };
    await flashDevice(radio, picked, buildDfuFile(SECOND_SLOT, firmware), quietContext());
    expect(sim.violations).toEqual([]);
    expect(sim.committed).toBe(true);
    expect(Buffer.compare(sim.image, firmware)).toBe(0);
  });

  it('refuses a file for another address, and a backup', async () => {
    const sim = new SimCs7000Robot();
    const picked = { api: 'usb' as const, device: sim as unknown as USBDevice };
    const ctx = quietContext();
    await expect(flashDevice(radio, picked, buildDfuFile(0x08000000, image(4096)), ctx)).rejects.toThrow(
      /not built for the radio's second firmware slot/,
    );
    await expect(flashDevice(radio, picked, image(4096), ctx, true)).rejects.toThrow(
      'A backup cannot be written in this flashing mode.',
    );
    expect(sim.opened).toBe(false);
  });
});
