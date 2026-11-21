// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Read-only backup of a Radtel RT-950 Pro that is running Radtel's firmware, over Web
 * Serial and the programming cable.
 *
 * This is a port of the read path of cps_flash.py in Hertzz58's
 * Radtel-RT950-Pro-Firmware, https://github.com/Hertzz58/Radtel-RT950-Pro-Firmware
 * (tools/cps_flash.py, GPL-3.0), which was worked out from Radtel's programming
 * software. 115200 8N1. The session opens with `PROGRAMBT9000U`, answered `06`; `F`
 * gives 16 bytes of identity, `M` the 12-byte model name; then a 25-byte `SEND` packet
 * picks one of twenty 4-byte keys, answered `06`. `52 addrH addrL len` then asks for up
 * to 128 bytes at a 16-bit address of the external memory chip, and the radio answers
 * with the same four bytes and the data, scrambled with the key. A lone `06` ends the
 * session. The address map is from the same tool.
 *
 * The address is 16 bits, so the first 64 KiB of the 4 MiB chip is all this reaches:
 * channels, VFOs, settings, DTMF, APRS and the calibration areas near the top. The
 * area from 0xF000 is read first, because its checksum is what tells one radio from
 * another.
 *
 * Only `52` reads are ever sent after the handshake. The same protocol writes with
 * `57`, `58` and `45`; this file has no code that could build one.
 */
import { ByteReader } from '../flash/bytes.ts';
import { FlashError, type FlashContext } from '../flash/types.ts';
import type { AlreadyBackedUp, BackupPart, Known, RadioBackup } from './types.ts';

/** Serial speed; 8 data bits, no parity, 1 stop bit. */
export const RT950_STOCK_BAUD_RATE = 115200;
/** Everything the 16-bit address reaches. */
export const RT950_STOCK_BYTES = 0x10000;
/** Bytes per read (BLOCK_SIZE in the reference). */
export const RT950_STOCK_BLOCK = 128;
/** Where the area starts whose checksum stands in for a serial number: factory calibration. */
export const RT950_CALIBRATION_START = 0xf000;
/** The model name the radio must give, before any padding. */
export const RT950_STOCK_MODEL = 'RT-950';

const HANDSHAKE = 'PROGRAMBT9000U';
const ACK = 0x06;
const CMD_READ = 0x52;

/** The twenty keys of the programming software (XOR_KEY_TABLE in the reference). */
const KEYS = [
  'BHT ',
  'CO 7',
  'A ES',
  ' EIY',
  'M PQ',
  'XN Y',
  'RVB ',
  ' HQP',
  'W RC',
  'MS N',
  ' SAT',
  'K DH',
  'ZO R',
  'C SL',
  '6RB ',
  ' JCG',
  'PN V',
  'J PK',
  'EK L',
  'I LZ',
];

/** Options for readRt950Stock(). */
export interface Rt950StockOptions {
  /** Wait for each answer, in milliseconds; 2000 as in the reference. */
  responseTimeoutMs?: number;
  /** How long the line must stay quiet, in milliseconds, before stale input counts as drained. */
  quietMs?: number;
  /** How many times a block is asked for before the read gives up; 3 by default. */
  attempts?: number;
  /** Source of the random numbers in the key packet, each in [0, 1); Math.random by default. */
  random?: () => number;
}

/**
 * Scrambles or unscrambles `data` with a 4-byte key: each byte is XORed with its key
 * byte, except where the key byte is a space or the byte is 0x00, 0xFF, the key byte
 * or its complement. The same steps go both ways (xor_decrypt in the reference).
 */
export function rt950StockXor(data: Uint8Array, key: Uint8Array): Uint8Array {
  return data.map((b, i) => {
    const k = key[i % 4];
    return k === 0x20 || b === 0x00 || b === 0xff || b === k || b === (k ^ 0xff) ? b : b ^ k;
  });
}

/**
 * Builds the 25-byte key packet: `SEND`, a selector, 19 table indices and a zero. The
 * selector says which of the indices names the key (_negotiate_encryption in the
 * reference). Returns the packet and the key it selects.
 */
export function rt950StockKeyPacket(random: () => number): { packet: Uint8Array; key: Uint8Array } {
  /** A whole number from `low` to `high`, both included. */
  const pick = (low: number, high: number) =>
    low + Math.min(high - low, Math.floor(random() * (high - low + 1)));
  const packet = new Uint8Array(25);
  packet.set(new TextEncoder().encode('SEND'));
  const selector = (pick(1, 2) << 4) | pick(0, 4);
  packet[4] = selector;
  for (let i = 5; i < 24; i++) packet[i] = pick(0, 19);
  const index = (selector & 0x20 ? (selector - 0x20) * 2 + 1 : (selector - 0x10) * 2) + 1;
  return { packet, key: new TextEncoder().encode(KEYS[packet[4 + index]]) };
}

/** Bytes as lower-case hex without separators. */
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Address as 0x%04X. */
function address(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * First 16 hex digits of the SHA-256 of `bytes`, or null when they are all 0xFF or
 * all 0x00 and so say nothing about the radio.
 */
async function fingerprint(bytes: Uint8Array): Promise<string | null> {
  if (bytes.every((b) => b === 0xff) || bytes.every((b) => b === 0x00)) return null;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice()));
  return hex(digest.subarray(0, 8));
}

/** Resolves after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads the first 64 KiB of the RT-950 Pro's memory chip while the radio runs Radtel's
 * firmware. Takes a closed port, opens it at 115200 baud and closes it again whatever
 * happens. Throws FlashError when the radio does not answer the way Radtel's firmware
 * does, when it is another model, or when a block cannot be read; nothing is returned
 * half read, since the whole read takes well under a minute.
 *
 * `known` is asked once the calibration area is in, whose fingerprint is the radio's
 * ID. When it says the radio is already backed up, the read ends there.
 */
export async function readRt950Stock(
  port: SerialPort,
  ctx: FlashContext,
  options?: Rt950StockOptions,
): Promise<RadioBackup>;
export async function readRt950Stock(
  port: SerialPort,
  ctx: FlashContext,
  options: Rt950StockOptions | undefined,
  known: Known | undefined,
): Promise<RadioBackup | AlreadyBackedUp>;
export async function readRt950Stock(
  port: SerialPort,
  ctx: FlashContext,
  options: Rt950StockOptions = {},
  known?: Known,
): Promise<RadioBackup | AlreadyBackedUp> {
  const responseTimeoutMs = options.responseTimeoutMs ?? 2000;
  const quietMs = options.quietMs ?? 100;
  const attempts = Math.max(1, options.attempts ?? 3);
  const total = RT950_STOCK_BYTES;
  const data = new Uint8Array(total);
  let done = 0;
  let identity: Uint8Array;
  /** Set when the radio turned out to be one that is already backed up. */
  let recognised: string | null = null;

  ctx.progress({ phase: 'connect', done: 0, total });
  try {
    await port.open({
      baudRate: RT950_STOCK_BAUD_RATE,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
    });
  } catch (e) {
    throw new FlashError(`Could not open the serial port: ${e instanceof Error ? e.message : String(e)}`);
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  /** True once the radio has entered its programming session, which must be ended. */
  let session = false;
  try {
    if (!port.readable || !port.writable) throw new FlashError('The serial port has no data streams.');
    reader = port.readable.getReader();
    writer = port.writable.getWriter();
    const input = new ByteReader(reader);
    const output = writer;

    /** Reads exactly `count` bytes, or null when the radio stops sending first. */
    const take = async (count: number): Promise<Uint8Array | null> => {
      const out = new Uint8Array(count);
      for (let i = 0; i < count; i++) {
        const byte = await input.readByte(responseTimeoutMs);
        if (byte === null) return null;
        out[i] = byte;
      }
      return out;
    };

    /** Reads the single ACK that ends a handshake step; `what` names the step. */
    const ack = async (what: string): Promise<void> => {
      const answer = await take(1);
      if (answer === null) throw new FlashError(`The radio stopped answering at the ${what}.`);
      if (answer[0] !== ACK) {
        throw new FlashError(
          `The radio answered the ${what} with 0x${hex(answer)}, which is not what Radtel's firmware sends.`,
        );
      }
    };

    // The handshake, in the reference's order.
    await input.drain(quietMs, 4096);
    await output.write(new TextEncoder().encode(HANDSHAKE));
    const first = await take(1);
    if (first === null) {
      throw new FlashError(
        "The radio did not answer. Check that the programming cable is pushed in all the way, that the radio is switched on in normal mode, not flashing mode, and that it still runs Radtel's firmware.",
      );
    }
    if (first[0] !== ACK) {
      throw new FlashError(
        `The radio answered, but not the way Radtel's firmware does (0x${hex(first)}). Check the cable, and that the radio still runs Radtel's firmware.`,
      );
    }
    session = true;

    await output.write(new TextEncoder().encode('F'));
    const who = await take(16);
    if (who === null) throw new FlashError('The radio stopped answering when asked to identify itself.');
    identity = who;

    await output.write(new TextEncoder().encode('M'));
    const named = await take(12);
    if (named === null) throw new FlashError('The radio stopped answering when asked for its model.');
    const model = String.fromCharCode(...named)
      .replace(/[\0 ]+$/, '')
      .replace(/[^\x20-\x7e]/g, '?');
    if (!model.startsWith(RT950_STOCK_MODEL)) {
      throw new FlashError(`This radio says it is "${model}", not an RT-950 Pro. Nothing was read.`);
    }

    const { packet, key } = rt950StockKeyPacket(options.random ?? Math.random);
    await output.write(packet);
    await ack('key exchange');
    ctx.log(`The radio is running Radtel's firmware (model ${model}); reading its memory`);

    /** Reads `length` bytes at `at`, asking again when an answer is short or is for another address. */
    const readBlock = async (at: number, length: number): Promise<Uint8Array> => {
      const request = Uint8Array.of(CMD_READ, (at >> 8) & 0xff, at & 0xff, length);
      let why = '';
      for (let attempt = 1; attempt <= attempts; attempt++) {
        await output.write(request);
        const reply = await take(4 + length);
        if (reply === null) why = 'the radio stopped answering';
        else if (reply[0] !== request[0] || reply[1] !== request[1] || reply[2] !== request[2]) {
          why = `the answer starts with ${hex(reply.subarray(0, 3))}, not ${hex(request.subarray(0, 3))}`;
        } else return rt950StockXor(reply.subarray(4), key);
        ctx.log(`Block at ${address(at)}: ${why} (try ${attempt})`);
        // Whatever is left of a broken answer must not be taken for the next one.
        await input.drain(quietMs, 2 * (4 + length));
      }
      throw new FlashError(`The read stopped at ${address(at)}: ${why}. Nothing was saved; try again.`);
    };

    /** Reads from `from` up to `to` into `data`, block by block. */
    const readRange = async (from: number, to: number): Promise<void> => {
      for (let at = from; at < to; at += RT950_STOCK_BLOCK) {
        const length = Math.min(RT950_STOCK_BLOCK, to - at);
        data.set(await readBlock(at, length), at);
        done += length;
        ctx.progress({ phase: 'read', done, total });
      }
    };

    // The calibration first: it is what tells this radio from another.
    await readRange(RT950_CALIBRATION_START, total);
    if (known) {
      const id = await fingerprint(data.subarray(RT950_CALIBRATION_START));
      if (id !== null && known(id)) {
        ctx.log('This radio already has a backup; not reading it again.');
        recognised = id;
      }
    }
    if (recognised === null) await readRange(0, RT950_CALIBRATION_START);
  } finally {
    // End the programming session so the radio goes back to normal (close() in the reference).
    if (session && writer) {
      await writer.write(Uint8Array.of(ACK)).catch(() => {});
      await sleep(50);
    }
    // Chrome refuses to close a port whose streams are locked. Cancelling also ends a
    // read that is still waiting.
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    writer?.releaseLock();
    await port.close().catch(() => {});
  }

  if (recognised !== null) return { known: recognised };

  const part: BackupPart = { file: 'spi-flash.bin', kind: 'spi-flash', address: 0, data, complete: true };
  const notes = [
    'This is the first 64 KB of the 4 MB memory chip, which is all the programming protocol reaches: channels, VFOs, settings, DTMF, APRS and the calibration areas. The fonts and the start-up picture further up the chip are not included.',
    "The firmware is not in this backup: the radio's bootloader cannot be read. Radtel publishes it at https://www.radtels.com/pages/software-download.",
    `In the handshake the radio identified itself as ${hex(identity)}.`,
  ];
  const radioId = await fingerprint(data.subarray(RT950_CALIBRATION_START));
  if (radioId === null) {
    notes.push('The calibration area is empty, so nothing in this backup tells this radio from another.');
  }
  ctx.progress({ phase: 'done', done, total });
  ctx.log(`Read ${done} (0x${done.toString(16)}) bytes`);
  return { radioId, idKind: radioId === null ? null : 'fingerprint', parts: [part], notes };
}
