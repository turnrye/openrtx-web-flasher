// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Read-only backup of a Radtel RT-4D that is running its original firmware, over Web
 * Serial and the programming (K-plug) cable.
 *
 * The block read is the one in RT-4D-SPIFlash-CLI, Copyright 2025 Dual Tachyon,
 * https://github.com/DualTachyon/rt-4d-spiflash-cli (RT-4D-UART.cs and Program.cs,
 * Apache-2.0): 115200 8N1, `52 blkH blkL cs` asks for one 1024-byte block of the
 * external SPI flash by its 16-bit index, and the radio answers 3 header bytes, the
 * 1024 data bytes and a checksum. Every checksum is the plain 8-bit sum of the bytes
 * before it. A radio in its bootloader answers `FF` instead, which is how that tool
 * tells the two apart. The memory map is Dual Tachyon's Flash-Layout wiki page,
 * https://github.com/DualTachyon/rt-4d-wiki/wiki/Flash-Layout (CC-BY-4.0).
 *
 * That tool also sends `34 00 00 10 cs` ("notify") before the bulk read and
 * `34 52 05 EE 79` ("close") after a complete read or write. Neither is sent here: the
 * tool itself reads block 0 before the notify and ignores the notify's result, so
 * reading does not depend on it, and without a notify there is nothing to close.
 *
 * Taken from Dual Tachyon's open firmware for the sibling RT-890, not from an RT-4D
 * source (https://github.com/DualTachyon/radtel-rt-890-oefw, app/uart.c, Apache-2.0;
 * same protocol with 128-byte blocks): the 3 header bytes repeat the request, the read
 * is served without any session, the notify does nothing but answer `06`, and the
 * close restarts the radio only after a write. The header check below rests on the
 * first of those.
 *
 * Only `52` reads are ever sent. The same serial protocol accepts region writes
 * (first byte 0x40 or 0x90-0xA5); this file has no code that could build one.
 */
import { RT4D_BAUD_RATE } from '../flash/rt4d.ts';
import { FlashError, type FlashContext } from '../flash/types.ts';
import type { AlreadyBackedUp, BackupPart, BackupScope, Known, RadioBackup } from './types.ts';

/** Bytes per block of the read command. */
export const RT4D_SPI_BLOCK_SIZE = 0x400;
/** Scope 'quick': calibration, settings, channels, zones, contacts and the other user data. */
export const RT4D_QUICK_BYTES = 0x100000;
/** Scope 'all': the 4 MiB the reference tool dumps (4096 blocks). */
export const RT4D_ALL_BYTES = 0x400000;
/** The calibration area, whose checksum stands in for a serial number. */
export const RT4D_CALIBRATION_BYTES = 0x1000;

const CMD_READ_SPI = 0x52;
const BOOTLOADER_RESPONSE = 0xff;
/** Header, data and checksum. */
const REPLY_BYTES = 3 + RT4D_SPI_BLOCK_SIZE + 1;

/** Options for readRt4dStock(). */
export interface Rt4dStockOptions {
  /**
   * Wait for the start of an answer, and for each further piece of it, in
   * milliseconds. 2000 by default; the reference tool allows 10000.
   */
  responseTimeoutMs?: number;
  /** How long the line must stay quiet, in milliseconds, before stale input counts as drained. */
  quietMs?: number;
  /** How many times a block is asked for before the read gives up; 3 by default. */
  attempts?: number;
}

/** Checksum of the original firmware's protocol: the sum of the bytes, modulo 256. */
export function rt4dStockChecksum(bytes: Uint8Array): number {
  let sum = 0;
  for (const b of bytes) sum += b;
  return sum & 0xff;
}

/** Hex dump for log and error messages. */
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

/** Address as 0x%06X. */
function address(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(6, '0')}`;
}

/**
 * First 16 hex digits of the SHA-256 of `bytes`, or null when they are all 0xFF or
 * all 0x00 and so say nothing about the radio.
 */
async function fingerprint(bytes: Uint8Array): Promise<string | null> {
  if (bytes.every((b) => b === 0xff) || bytes.every((b) => b === 0x00)) return null;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice()));
  return hex(digest.subarray(0, 8)).replaceAll(' ', '');
}

/** Reads with a timeout over a stream reader, whole chunks at a time. */
class SerialInput {
  private chunk: Uint8Array = new Uint8Array(0);
  private at = 0;
  /** A read that outlived its timeout; the next call picks it up, so no bytes are lost. */
  private pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;

  /** Wraps `reader`; the caller keeps ownership of the lock. */
  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  /** Waits for input when none is buffered; false when none arrives within `timeoutMs`. */
  private async fill(timeoutMs: number): Promise<boolean> {
    while (this.at >= this.chunk.length) {
      this.pending ??= this.reader.read();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      });
      const result = await Promise.race([this.pending, timeout]);
      clearTimeout(timer);
      if (result === null) return false;
      this.pending = null;
      if (result.done) throw new FlashError('The serial port closed while reading the radio.');
      this.chunk = result.value;
      this.at = 0;
    }
    return true;
  }

  /**
   * Fills `out` from offset `from`; returns how many bytes of `out` are filled when
   * the radio stops sending for `timeoutMs`.
   */
  async read(out: Uint8Array, from: number, timeoutMs: number): Promise<number> {
    let got = from;
    while (got < out.length) {
      if (!(await this.fill(timeoutMs))) break;
      const take = Math.min(out.length - got, this.chunk.length - this.at);
      out.set(this.chunk.subarray(this.at, this.at + take), got);
      this.at += take;
      got += take;
    }
    return got;
  }

  /** Discards input until the line has been quiet for `quietMs`, or `limit` bytes went by. */
  async drain(quietMs: number, limit: number): Promise<number> {
    let dropped = 0;
    while (dropped < limit && (await this.fill(quietMs))) {
      dropped += this.chunk.length - this.at;
      this.at = this.chunk.length;
    }
    return dropped;
  }
}

/** Why one request for a block failed. */
interface BlockFailure {
  /** 'silent': no answer; 'refused': the bootloader's FF; 'garbled': anything else. */
  kind: 'silent' | 'refused' | 'garbled';
  /** For the log and the part's note. */
  detail: string;
}

/**
 * Asks for one block and checks the answer as Command_ReadSpi() does (first byte not
 * FF, checksum), plus the header. Returns the 1024 data bytes or the reason it failed.
 */
async function readBlock(
  input: SerialInput,
  output: WritableStreamDefaultWriter<Uint8Array>,
  block: number,
  timeoutMs: number,
): Promise<Uint8Array | BlockFailure> {
  const request = Uint8Array.of(CMD_READ_SPI, (block >> 8) & 0xff, block & 0xff, 0);
  request[3] = rt4dStockChecksum(request.subarray(0, 3));
  await output.write(request);

  const reply = new Uint8Array(REPLY_BYTES);
  let got = await input.read(reply.subarray(0, 1), 0, timeoutMs);
  if (got === 0) return { kind: 'silent', detail: 'no answer' };
  if (reply[0] === BOOTLOADER_RESPONSE) return { kind: 'refused', detail: 'the radio answered FF' };
  got = await input.read(reply, 1, timeoutMs);
  if (got < REPLY_BYTES) {
    return { kind: 'garbled', detail: `the answer stopped after ${got} of ${REPLY_BYTES} bytes` };
  }
  if (rt4dStockChecksum(reply.subarray(0, REPLY_BYTES - 1)) !== reply[REPLY_BYTES - 1]) {
    return { kind: 'garbled', detail: 'the checksum of the answer is wrong' };
  }
  if (reply[0] !== request[0] || reply[1] !== request[1] || reply[2] !== request[2]) {
    return {
      kind: 'garbled',
      detail: `the answer starts with ${hex(reply.subarray(0, 3))}, not ${hex(request.subarray(0, 3))}`,
    };
  }
  return reply.slice(3, 3 + RT4D_SPI_BLOCK_SIZE);
}

/** The error for a radio that never gave block 0, from what its answers looked like. */
function noFirstBlock(failures: BlockFailure[]): FlashError {
  if (failures.every((f) => f.kind === 'silent')) {
    return new FlashError(
      'The radio did not answer. Check that the programming cable is pushed in all the way and that the radio is switched on.',
    );
  }
  if (failures.some((f) => f.kind === 'refused')) {
    return new FlashError(
      'The radio is in flashing mode, where its memory cannot be read. Switch it off, then switch it on normally, without holding any key, and try again.',
    );
  }
  const last = failures[failures.length - 1];
  return new FlashError(
    `The radio answered, but not the way the original RT-4D firmware does (${last.detail}). Check the cable, and that the radio still has its original firmware.`,
  );
}

/**
 * Reads the start of the RT-4D's SPI flash while the radio runs its original firmware:
 * the first 1 MiB for 'quick', the first 4 MiB for 'all'. Takes a closed port, opens it
 * at 115200 baud and closes it again whatever happens. Sends nothing but block reads.
 * Throws FlashError when not even the first block can be read; a read that fails later
 * returns what was read so far, marked incomplete.
 *
 * `known` is asked after the first 4 KiB, whose fingerprint is the radio's ID. When it
 * says the radio is already backed up, the read ends there.
 */
export async function readRt4dStock(
  port: SerialPort,
  scope: BackupScope,
  ctx: FlashContext,
  options?: Rt4dStockOptions,
): Promise<RadioBackup>;
export async function readRt4dStock(
  port: SerialPort,
  scope: BackupScope,
  ctx: FlashContext,
  options: Rt4dStockOptions | undefined,
  known: Known | undefined,
): Promise<RadioBackup | AlreadyBackedUp>;
export async function readRt4dStock(
  port: SerialPort,
  scope: BackupScope,
  ctx: FlashContext,
  options: Rt4dStockOptions = {},
  known?: Known,
): Promise<RadioBackup | AlreadyBackedUp> {
  const responseTimeoutMs = options.responseTimeoutMs ?? 2000;
  const quietMs = options.quietMs ?? 100;
  const attempts = Math.max(1, options.attempts ?? 3);
  const total = scope === 'quick' ? RT4D_QUICK_BYTES : RT4D_ALL_BYTES;
  const data = new Uint8Array(total);
  let done = 0;
  let stopped: string | null = null;
  /** Set when the radio turned out to be one that is already backed up. */
  let recognised: string | null = null;

  ctx.progress({ phase: 'connect', done: 0, total });
  try {
    await port.open({
      baudRate: RT4D_BAUD_RATE,
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
    const input = new SerialInput(reader);

    await input.drain(quietMs, 4096);
    for (let block = 0; done < total; block++) {
      const failures: BlockFailure[] = [];
      let found: Uint8Array | null = null;
      try {
        while (found === null && failures.length < attempts) {
          const result = await readBlock(input, writer, block, responseTimeoutMs);
          if (result instanceof Uint8Array) {
            found = result;
          } else {
            failures.push(result);
            ctx.log(`Block ${block} at ${address(done)}: ${result.detail} (try ${failures.length})`);
            // Whatever is left of a broken answer must not be taken for the next one.
            await input.drain(quietMs, 2 * REPLY_BYTES);
          }
        }
      } catch (e) {
        // The port went away; what was read before stays, and with nothing read it is an error.
        const message = e instanceof Error ? e.message : String(e);
        if (block === 0)
          throw e instanceof FlashError ? e : new FlashError(`Lost the serial port: ${message}`);
        failures.push({ kind: 'garbled', detail: message });
      }
      if (found === null) {
        if (block === 0) throw noFirstBlock(failures);
        stopped = failures[failures.length - 1].detail;
        break;
      }
      if (block === 0) ctx.log('The radio is running its original firmware; reading its memory');
      data.set(found, done);
      done += RT4D_SPI_BLOCK_SIZE;
      ctx.progress({ phase: 'read', done, total });
      // The calibration at the start of the chip is what tells this radio from another.
      if (known && done === RT4D_CALIBRATION_BYTES) {
        const id = await fingerprint(data.subarray(0, RT4D_CALIBRATION_BYTES));
        if (id !== null && known(id)) {
          ctx.log('This radio already has a backup; not reading it again.');
          recognised = id;
          break;
        }
      }
    }
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

  if (recognised !== null) return { known: recognised };

  const part: BackupPart = {
    file: 'spi-flash.bin',
    kind: 'spi-flash',
    address: 0,
    data: stopped === null ? data : data.slice(0, done),
    complete: stopped === null,
  };
  const notes: string[] = [];
  if (stopped !== null) {
    part.note = `The read stopped at ${address(done)} of ${address(total)}: ${stopped.replace(/\.$/, '')}.`;
    notes.push(
      `Only the first ${done} of ${total} bytes were read; then the radio stopped answering properly. Read it again for a complete backup.`,
    );
  }
  if (scope === 'quick') {
    notes.push(
      'This is the first megabyte of the memory chip: calibration, settings, channels, zones, contacts and the other things you can change. The boot logo, fonts and voice prompts above it are not included.',
    );
  } else {
    notes.push(
      'This is the first 4 MiB of the 16 MiB memory chip. The address book above it (0x400000 to 0xFFFFFF) is not included.',
    );
  }

  const radioId =
    done >= RT4D_CALIBRATION_BYTES ? await fingerprint(data.subarray(0, RT4D_CALIBRATION_BYTES)) : null;
  if (radioId === null) {
    notes.push(
      'The calibration area was not read or is empty, so nothing in this backup tells this radio from another.',
    );
  }
  ctx.progress({ phase: 'done', done, total });
  ctx.log(
    stopped === null
      ? `Read ${done} (0x${done.toString(16)}) bytes`
      : `Read ${done} of ${total} bytes, then stopped: ${stopped}`,
  );
  return { radioId, idKind: radioId === null ? null : 'fingerprint', parts: [part], notes };
}
