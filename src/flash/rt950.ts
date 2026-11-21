// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Firmware flasher for the Radtel RT-950 Pro over Web Serial.
 *
 * It follows the bootloader protocol as Marko13 worked it out for OpenRTX's RT-950 Pro
 * port: scripts/rt950_flash.py in https://github.com/Marko13-dev/OpenRTX (branch
 * rt950pro, 7c8ac095), reverse engineered from Radtel's update tool. Packets, checksum,
 * order, timeouts and the retry of a data block are that script's. Only its direct
 * path is here, the one its README documents: the radio is already in the bootloader.
 *
 * The file is a .BTF, the format Radtel's own tool takes (scripts/rt950_btf.py in the
 * same branch makes one). It is sent as it is; the bootloader unscrambles it. The
 * bootloader itself, the first 12 KiB of flash, is never written.
 */
import { ByteReader } from './bytes.ts';
import { FlashError, type FlashContext } from './types.ts';

/** Serial speed; 8 data bits, no parity, 1 stop bit. */
export const RT950_BAUD_RATE = 115200;
/** Bytes per data packet (DATA_BLOCK_SIZE in the reference). */
export const RT950_BLOCK_SIZE = 1024;
/** The model the bootloader accepts, at RT950_MODEL_OFFSET of the file, padded with spaces. */
export const RT950_MODEL = 'RT-950      ';
/** Where the 32-byte model signature sits in a .BTF. */
export const RT950_MODEL_OFFSET = 0x3e0;
const MODEL_SIZE = 32;
/** A .BTF holds 1 KiB of plain firmware and a 1 KiB key block before anything else. */
const BTF_MIN_SIZE = 0x800;

const HEADER = 0xaa;
const FOOTER = 0x55;
const CMD_PROBE = 0x42;
const CMD_VERSION = 0x0a;
const CMD_MODEL = 0x02;
const CMD_PKG_COUNT = 0x04;
const CMD_DATA = 0x03;
const CMD_END = 0x45;
const RESULT_ACK = 0x06;
const VERSION_STRING = 'BOOTLOADER_V3';
/** Attempts per data block (DATA_BLOCK_RETRIES). */
const DATA_BLOCK_RETRIES = 5;

/** What the bootloader's result codes mean (RESULT_NAMES in the reference). */
const RESULTS: Record<number, string> = {
  0x06: 'ACK',
  0xe1: 'wrong data length',
  0xe2: 'data verification error',
  0xe3: 'flash write error',
  0xe5: 'ready',
  0xe6: 'model mismatch',
};

/** Options for flashRt950(); the defaults are the reference's timings. */
export interface Rt950Options {
  /** Wait for the answer to the probe, in milliseconds. */
  probeTimeoutMs?: number;
  /** Wait for the answer to the version, model and count commands, in milliseconds. */
  responseTimeoutMs?: number;
  /** Wait for the answer to a data block and to the end command, in milliseconds. */
  dataTimeoutMs?: number;
  /** Pause after each accepted block, so the next does not arrive during a flash write. */
  settleMs?: number;
  /** Pause before a block is sent again. */
  retryDelayMs?: number;
  /** How long the line must stay quiet before stale input counts as drained. */
  quietMs?: number;
}

/** CRC-CCITT, polynomial 0x1021, starting from 0 (crc_ccitt in the reference). */
export function rt950Crc(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
  }
  return crc;
}

/**
 * Builds a packet: 0xAA, command, argument (2 bytes), data length (2 bytes), data,
 * CRC of everything after the 0xAA (2 bytes), 0x55. Multi-byte fields are big-endian.
 */
export function rt950Packet(command: number, argument = 0, data: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(data.length + 9);
  out[0] = HEADER;
  out[1] = command;
  out[2] = (argument >> 8) & 0xff;
  out[3] = argument & 0xff;
  out[4] = (data.length >> 8) & 0xff;
  out[5] = data.length & 0xff;
  out.set(data, 6);
  const crc = rt950Crc(out.subarray(1, 6 + data.length));
  out[6 + data.length] = crc >> 8;
  out[7 + data.length] = crc & 0xff;
  out[8 + data.length] = FOOTER;
  return out;
}

/** The model name a .BTF carries, or null when the file is too short to hold one. */
export function rt950ModelOf(btf: Uint8Array): string | null {
  if (btf.length < RT950_MODEL_OFFSET + MODEL_SIZE) return null;
  const name = btf.subarray(RT950_MODEL_OFFSET, RT950_MODEL_OFFSET + RT950_MODEL.length);
  return String.fromCharCode(...name);
}

/** A result code as words. */
function resultName(result: number): string {
  return RESULTS[result] ?? `0x${result.toString(16).padStart(2, '0')}`;
}

/** Resolves after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Flashes a .BTF onto an RT-950 Pro that is in its bootloader. Takes a closed port,
 * opens it at 115200 baud and closes it again whatever happens. Throws FlashError when
 * the file is not an RT-950 Pro .BTF (nothing is sent then), when the radio does not
 * answer, or when it refuses a step.
 */
export async function flashRt950(
  port: SerialPort,
  btf: Uint8Array,
  ctx: FlashContext,
  options: Rt950Options = {},
): Promise<void> {
  const probeTimeoutMs = options.probeTimeoutMs ?? 1000;
  const responseTimeoutMs = options.responseTimeoutMs ?? 5000;
  const dataTimeoutMs = options.dataTimeoutMs ?? 10000;
  const settleMs = options.settleMs ?? 12;
  const retryDelayMs = options.retryDelayMs ?? 150;
  const quietMs = options.quietMs ?? 100;

  // The bootloader checks little, so a wrong file is refused here, before anything is sent.
  if (btf.length < BTF_MIN_SIZE) {
    throw new FlashError(`This is not an RT-950 Pro .BTF file: it is only ${btf.length} bytes.`);
  }
  const model = rt950ModelOf(btf);
  if (model !== RT950_MODEL) {
    throw new FlashError(
      'This is not an RT-950 Pro .BTF file: it does not carry the model name the bootloader looks for. Nothing was sent to the radio.',
    );
  }
  const blocks = Math.ceil(btf.length / RT950_BLOCK_SIZE);
  const total = blocks * RT950_BLOCK_SIZE;
  ctx.log(`Firmware size ${btf.length} (0x${btf.length.toString(16)}) bytes, ${blocks} blocks`);

  ctx.progress({ phase: 'connect', done: 0, total });
  try {
    await port.open({
      baudRate: RT950_BAUD_RATE,
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
  try {
    if (!port.readable || !port.writable) throw new FlashError('The serial port has no data streams.');
    reader = port.readable.getReader();
    writer = port.writable.getWriter();
    const input = new ByteReader(reader);
    const output = writer;

    /**
     * Sends one packet and reads the 9-byte answer: 0xAA, command, 0, result, 0, 0, CRC,
     * 0x55. Returns the result code, or null when no answer came in time. Like the
     * reference it looks for the 0xAA and reads the result; it does not check the CRC.
     */
    const command = async (bytes: Uint8Array, timeoutMs: number): Promise<number | null> => {
      await output.write(bytes);
      const deadline = Date.now() + timeoutMs;
      const answer: number[] = [];
      while (answer.length < 9) {
        const left = deadline - Date.now();
        const byte = left > 0 ? await input.readByte(left) : null;
        if (byte === null) return null;
        // Anything before the 0xAA is noise on the line.
        if (answer.length > 0 || byte === HEADER) answer.push(byte);
      }
      return answer[3];
    };

    /** Sends a command that must be acknowledged; `what` names the step in the error. */
    const step = async (bytes: Uint8Array, what: string): Promise<void> => {
      const result = await command(bytes, responseTimeoutMs);
      if (result === null) {
        throw new FlashError(`${what}: the radio did not answer. Is it connected and in flashing mode?`);
      }
      if (result !== RESULT_ACK) throw new FlashError(`${what}: the radio answered "${resultName(result)}".`);
    };

    // Direct mode: the radio was switched on in the bootloader. Throw away stale input,
    // then probe. Any framed answer means the bootloader is there; like the reference,
    // go on without one and let the next command decide.
    await input.drain(quietMs, 4096);
    const probe = await command(rt950Packet(CMD_PROBE), probeTimeoutMs);
    ctx.log(
      probe === null ? 'No answer to the probe; trying anyway' : `Bootloader answered: ${resultName(probe)}`,
    );

    await step(rt950Packet(CMD_VERSION, 0, new TextEncoder().encode(VERSION_STRING)), 'Version check failed');
    const signature = btf.subarray(RT950_MODEL_OFFSET, RT950_MODEL_OFFSET + MODEL_SIZE);
    await step(rt950Packet(CMD_MODEL, 0, signature), 'The radio refused the firmware');
    ctx.log(`Model "${model.trimEnd()}" accepted`);
    await step(
      rt950Packet(CMD_PKG_COUNT, 0, Uint8Array.of(((blocks - 1) >> 8) & 0xff, (blocks - 1) & 0xff)),
      'The radio refused the size of the firmware',
    );

    ctx.log('Flashing');
    ctx.progress({ phase: 'write', done: 0, total });
    for (let seq = 0; seq < blocks; seq++) {
      // The last block is padded with zeros, as in the reference.
      const block = new Uint8Array(RT950_BLOCK_SIZE);
      block.set(btf.subarray(seq * RT950_BLOCK_SIZE, (seq + 1) * RT950_BLOCK_SIZE));
      const packet = rt950Packet(CMD_DATA, seq, block);

      // The radio drops bytes while it writes a flash page, so a block can arrive
      // chopped. Sending it again is safe: the packet names its own block number.
      let result: number | null = null;
      for (let attempt = 0; attempt < DATA_BLOCK_RETRIES; attempt++) {
        if (attempt > 0) {
          await sleep(retryDelayMs);
          await input.drain(quietMs, 4096);
        }
        result = await command(packet, dataTimeoutMs);
        if (result === RESULT_ACK) break;
        ctx.log(
          `Block ${seq}: ${result === null ? 'no answer' : resultName(result)} (attempt ${attempt + 1} of ${DATA_BLOCK_RETRIES})`,
        );
      }
      if (result !== RESULT_ACK) {
        throw new FlashError(
          result === null
            ? `Writing stopped at block ${seq} of ${blocks}: the radio no longer answers.`
            : `Writing failed at block ${seq} of ${blocks}: the radio answered "${resultName(result)}".`,
        );
      }
      await sleep(settleMs);
      ctx.progress({ phase: 'write', done: (seq + 1) * RT950_BLOCK_SIZE, total });
    }

    const end = await command(rt950Packet(CMD_END), dataTimeoutMs);
    if (end === null) throw new FlashError('The radio did not confirm the end of the update.');
    if (end !== RESULT_ACK)
      ctx.log(`Warning: the radio answered "${resultName(end)}" to the end of the update.`);

    ctx.progress({ phase: 'done', done: total, total });
    ctx.log(`Sent ${blocks} blocks. The radio restarts with the new firmware.`);
  } finally {
    // Chrome refuses to close a port whose streams are locked. Cancelling also ends a
    // read that is still waiting.
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    writer?.releaseLock();
    await port.close().catch(() => {});
  }
}
