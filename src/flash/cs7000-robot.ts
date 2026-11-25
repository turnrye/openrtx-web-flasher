// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Flasher for the Connect Systems CS7000-M17 Plus through its own bootloader, which
 * Connect Systems calls robot mode: the way their Factory Tool loads OpenRTX into the
 * radio's second firmware slot. It is the only way into a radio that still has its
 * Connect Systems firmware, because that firmware read-protects the chip and the
 * chip's own DFU mode then refuses everything.
 *
 * In robot mode the radio is a USB drive without a disk (0483:5720). Frames travel in
 * the data of two vendor SCSI commands. A frame is A1, a 16-bit command, a 16-bit
 * payload length, the payload, the 16-bit sum of the payload bytes and A4, all
 * big-endian; what the host sends is XORed with a 256-byte table that starts over with
 * every frame, and the radio answers in the clear. A session is one connect, the image
 * in 2048-byte blocks, and one commit.
 *
 * The frame layout, the command numbers and the table are facts about the radio's
 * bootloader, worked out from the Factory Tool's USB traffic by imostlylurk for
 * cs7000plus_flasher.py, https://github.com/imostlylurk/cs7000plus_flasher (Apache-2.0).
 * The table is copied from it; the code is written here.
 */
import { FlashError, type FlashContext } from './types.ts';
import { UsbStorage } from './usb-storage.ts';

/** Where the radio's second firmware slot is in the chip's flash. */
export const SECOND_SLOT = 0x08100000;
/** How much the second slot holds. */
export const SECOND_SLOT_SIZE = 0x100000;
/** Bytes of image per data frame; the last one is filled up with 0xFF. */
export const ROBOT_BLOCK = 2048;

/** Commands of a session that loads the second slot. The radio's answer has the top bit set. */
export const RobotCommand = {
  CONNECT: 0x064c,
  DATA: 0x0642,
  COMMIT: 0x0644,
} as const;
/** The bit that turns a command into its answer. */
export const ROBOT_ANSWER = 0x8000;

/** Payload of the connect frame. */
const CONNECT_PAYLOAD = Uint8Array.of(0x01, 0x02, 0xff);
/** First byte of a data frame's header. */
export const DATA_TAG = 0x22;
/** What the radio puts in its answer to a block it took, and to the commit. */
const ACCEPTED = 0x21;

/** The vendor SCSI commands that carry a frame to the radio and fetch its answer. */
export const CDB_SEND = Uint8Array.of(0xff, 0x2a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x47, 0x50);
export const CDB_FETCH = Uint8Array.of(0xff, 0x28, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x47, 0x50);
/** How many bytes of answer to ask for. */
const FETCH_LENGTH = 256;
/** How long the radio gets before its answer is fetched, and between tries. */
const ANSWER_WAIT_MS = 20;
/** How often an answer is fetched before the radio counts as silent. */
const ANSWER_TRIES = 5;

/** Initial stack pointer of every OpenRTX build for this radio. */
const STACK_POINTER = 0x24000200;

/** The table frames for the second slot are XORed with. */
const SCRAMBLE = Uint8Array.from(
  (
    '5c6c6b6a68678865646261605e5d5a59746c6d6e6f7071727375757677787879' +
    '37442d33424547484a4b104e513754567c7f7e287e7e1d2b7e7d7d7d7c7b7b7a' +
    '307a3477792b127d7d007e307e557e7e2012132e161718191a1c1d1e21222425' +
    '3127282a2b2d2e3033343637393a3c3d712b99783c7776887530733a703a6e6d' +
    '5756545351504e4d4b4a4847454488411a2767242221201e1d1c191817161413' +
    '440a040506060708090b0c0d0e0f101100000000000000990001010202030304' +
    '073f3d3c3a393736343331302e2d2b2a286157595a5c5d5e606264656688686a' +
    '6b123c100f0e0d0c0b0a090908063a0504040303330201010100550066000099'
  ).match(/../g)!,
  (pair) => parseInt(pair, 16),
);

/** A frame's command and payload. */
export interface RobotFrame {
  command: number;
  payload: Uint8Array;
}

/** Builds a frame in the clear. */
export function robotFrame(command: number, payload: Uint8Array): Uint8Array {
  const sum = payload.reduce((total, byte) => total + byte, 0) & 0xffff;
  const frame = new Uint8Array(payload.length + 8);
  frame.set([0xa1, command >> 8, command & 0xff, payload.length >> 8, payload.length & 0xff]);
  frame.set(payload, 5);
  frame.set([sum >> 8, sum & 0xff, 0xa4], 5 + payload.length);
  return frame;
}

/** Reads a frame in the clear; null when the bytes are not one whole, sound frame. */
export function parseRobotFrame(bytes: Uint8Array): RobotFrame | null {
  if (bytes.length < 8 || bytes[0] !== 0xa1 || bytes.at(-1) !== 0xa4) return null;
  const length = (bytes[3] << 8) | bytes[4];
  if (bytes.length !== length + 8) return null;
  const payload = bytes.slice(5, 5 + length);
  const sum = payload.reduce((total, byte) => total + byte, 0) & 0xffff;
  if (((bytes[5 + length] << 8) | bytes[6 + length]) !== sum) return null;
  return { command: (bytes[1] << 8) | bytes[2], payload };
}

/** XORs a frame with the table; the same call scrambles and unscrambles. */
export function scramble(frame: Uint8Array): Uint8Array {
  return frame.map((byte, i) => byte ^ SCRAMBLE[i % SCRAMBLE.length]);
}

/** The data frame for block `index` of `image`, in the clear. */
function dataFrame(image: Uint8Array, index: number): Uint8Array {
  const payload = new Uint8Array(9 + ROBOT_BLOCK).fill(0xff);
  const view = new DataView(payload.buffer);
  payload[0] = DATA_TAG;
  view.setUint16(1, index);
  view.setUint32(3, image.length);
  view.setUint16(7, ROBOT_BLOCK);
  payload.set(image.subarray(index * ROBOT_BLOCK, (index + 1) * ROBOT_BLOCK), 9);
  return robotFrame(RobotCommand.DATA, payload);
}

/** Bytes as spaced hex, for the log. */
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

/** A 32-bit little-endian value of `image`. */
function word(image: Uint8Array, offset: number): number {
  return new DataView(image.buffer, image.byteOffset, image.byteLength).getUint32(offset, true);
}

/**
 * Checks that `image` is an OpenRTX build for the second slot. Throws a FlashError
 * otherwise: the bootloader would start whatever it is given.
 */
export function checkSecondSlotImage(image: Uint8Array): void {
  if (image.length < 8) throw new FlashError('There is no firmware to write.');
  if (image.length > SECOND_SLOT_SIZE) {
    throw new FlashError("This firmware is larger than the radio's second firmware slot.");
  }
  const reset = word(image, 4);
  if (word(image, 0) !== STACK_POINTER || reset < SECOND_SLOT || reset >= SECOND_SLOT + SECOND_SLOT_SIZE) {
    throw new FlashError(
      "This firmware is not built for the radio's second firmware slot, where OpenRTX goes. " +
        'Nothing was sent to the radio.',
    );
  }
}

/** One exchange with the radio: frames out scrambled, answers back in the clear. */
class RobotLink {
  constructor(
    private readonly storage: UsbStorage,
    private readonly ctx: FlashContext,
  ) {}

  /**
   * Fetches what the radio has to say, without the zeroes it may be filled up with. A
   * radio that lets the fetch run out of time has nothing to say: the transport has put
   * itself right again by then, and the frame that follows shows whether the radio is
   * still there.
   */
  private async fetch(): Promise<Uint8Array> {
    let bytes: Uint8Array | null;
    try {
      bytes = await this.storage.read(CDB_FETCH, FETCH_LENGTH);
    } catch (e) {
      if (!(e instanceof FlashError)) throw e;
      bytes = null;
    }
    bytes ??= new Uint8Array(0);
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    return bytes.subarray(0, end);
  }

  /**
   * Sends `frame` and returns the payload of the radio's answer to it. Throws a
   * FlashError naming `what` when the radio does not take the frame or answers with
   * something else.
   */
  async exchange(frame: Uint8Array, what: string): Promise<Uint8Array> {
    const command = parseRobotFrame(frame)!.command;
    await this.fetch(); // anything left over from before is not the answer to this
    if (!(await this.storage.write(CDB_SEND, scramble(frame)))) {
      throw new FlashError(`The radio did not take ${what}.`);
    }
    let seen: Uint8Array = new Uint8Array(0);
    for (let tries = 0; tries < ANSWER_TRIES; tries++) {
      await this.ctx.sleep(ANSWER_WAIT_MS);
      seen = await this.fetch();
      if (seen.length > 0) break;
    }
    const answer = parseRobotFrame(seen);
    if (answer?.command !== (command | ROBOT_ANSWER)) {
      throw new FlashError(
        seen.length === 0
          ? `The radio did not answer ${what}.`
          : `The radio answered ${what} with something else (${hex(seen.subarray(0, 12))}).`,
      );
    }
    return answer.payload;
  }
}

/**
 * Writes `image`, a raw OpenRTX build for the second firmware slot, to a radio in robot
 * mode. Nothing can be read back in this mode, so the radio's word for every block is
 * all the checking there is.
 */
export async function flashCs7000Robot(dev: USBDevice, image: Uint8Array, ctx: FlashContext): Promise<void> {
  checkSecondSlotImage(image);
  const total = image.length;
  ctx.progress({ phase: 'connect', done: 0, total });
  const storage = await UsbStorage.open(dev);
  try {
    const link = new RobotLink(storage, ctx);
    const state = await link.exchange(
      robotFrame(RobotCommand.CONNECT, CONNECT_PAYLOAD),
      'the connect request',
    );
    ctx.log(`Connected to the radio's bootloader (it answered ${hex(state) || 'nothing more'}).`);

    const blocks = Math.ceil(total / ROBOT_BLOCK);
    ctx.log(`Writing ${total} bytes to the second firmware slot in ${blocks} blocks.`);
    ctx.progress({ phase: 'write', done: 0, total });
    // The Factory Tool goes by the answer's command alone, and so does this. What the
    // answer carries has only ever been seen as 21, so anything else is worth a line.
    let unusual = 0;
    const note = (what: string, answer: Uint8Array) => {
      if (answer[0] === ACCEPTED) return;
      if (unusual++ === 0)
        ctx.log(`The radio answered ${what} with ${hex(answer) || 'nothing'}, not the usual 21.`);
    };
    for (let index = 0; index < blocks; index++) {
      const at = `block ${index + 1} of ${blocks}`;
      note(at, await link.exchange(dataFrame(image, index), at));
      ctx.progress({ phase: 'write', done: Math.min((index + 1) * ROBOT_BLOCK, total), total });
    }
    note('the commit', await link.exchange(robotFrame(RobotCommand.COMMIT, new Uint8Array(0)), 'the commit'));
    if (unusual > 1) ctx.log(`${unusual} of its answers were unusual in that way.`);
    ctx.log(`The radio took all ${blocks} blocks. This mode cannot read them back to compare.`);
    ctx.progress({ phase: 'done', done: total, total });
  } finally {
    await storage.close();
  }
}
