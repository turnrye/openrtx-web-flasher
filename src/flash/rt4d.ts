// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Firmware flasher for the Radtel RT-4D over Web Serial.
 *
 * This is a port of the RT-4D flasher by Mikhail Yudin (fagci),
 * https://github.com/fagci/RT-4D-python-flasher (rt_4d_flasher.py, GPL-3.0), checked
 * against his Go version, https://github.com/fagci/rt4d-goflasher (main.go). Packets,
 * checksum, order and the 5 s timeout are his.
 *
 * The radio must be in its bootloader (flashing mode) and connected with a
 * programming cable. The image is a raw binary linked for 0x08002800, which is where
 * OpenRTX's AT32F423 linker script puts it; the bootloader's region from there to the
 * end of the 256 KiB flash is 0x3D800 bytes, the same 246 KiB the linker script
 * allows. The whole region is always written, zero-padded after the image.
 */
import { ByteReader } from './bytes.ts';
import { FlashError, type FlashContext } from './types.ts';

/** Serial speed; 8 data bits, no parity, 1 stop bit. */
export const RT4D_BAUD_RATE = 115200;
/** Size of the region the bootloader writes (MEMORY_SIZE in the reference). */
export const RT4D_MEMORY_SIZE = 0x3d800;
/** Bytes per write packet (WRITE_BLOCK_SIZE). */
export const RT4D_BLOCK_SIZE = 0x400;
/** Address of the first byte of the image, from OpenRTX's linker script. */
export const RT4D_LOAD_ADDRESS = 0x08002800;

const CMD_ERASE_FLASH = 0x39;
const CMD_READ_FLASH = 0x52;
const CMD_WRITE_FLASH = 0x57;
const ACK_RESPONSE = 0x06;
const FLASH_MODE_RESPONSE = 0xff;

/** Options for flashRt4d(). */
export interface Rt4dOptions {
  /** Wait for each answer, in milliseconds; the reference uses 5000. */
  responseTimeoutMs?: number;
  /**
   * How long the line must stay quiet, in milliseconds, before stale input counts as
   * drained and after the first probe byte before the probe reply counts as over.
   */
  quietMs?: number;
}

/** Packet checksum: (sum of the bytes + 72) mod 256 (append_checksum in the reference). */
export function rt4dChecksum(bytes: Uint8Array): number {
  let sum = 72;
  for (const b of bytes) sum += b;
  return sum & 0xff;
}

/** Builds a packet: the given bytes followed by their checksum. */
function packet(...parts: (number | Uint8Array)[]): Uint8Array {
  const length = parts.reduce<number>((n, p) => n + (typeof p === 'number' ? 1 : p.length), 0);
  const out = new Uint8Array(length + 1);
  let at = 0;
  for (const p of parts) {
    if (typeof p === 'number') out[at++] = p;
    else {
      out.set(p, at);
      at += p.length;
    }
  }
  out[at] = rt4dChecksum(out.subarray(0, at));
  return out;
}

/** Two-digit hex for messages. */
function hex(byte: number): string {
  return `0x${byte.toString(16).padStart(2, '0')}`;
}

/**
 * Flashes a raw OpenRTX image onto an RT-4D that is in its bootloader. Takes a closed
 * port, opens it at 115200 baud and closes it again whatever happens. Throws
 * FlashError when the image does not fit, the radio is not in flashing mode, or it
 * answers anything but ACK.
 */
export async function flashRt4d(
  port: SerialPort,
  bin: Uint8Array,
  ctx: FlashContext,
  options: Rt4dOptions = {},
): Promise<void> {
  const responseTimeoutMs = options.responseTimeoutMs ?? 5000;
  const quietMs = options.quietMs ?? 100;
  const total = RT4D_MEMORY_SIZE;

  if (bin.length === 0) throw new FlashError('The firmware file is empty.');
  if (bin.length > RT4D_MEMORY_SIZE) {
    throw new FlashError(
      `The firmware is too large for the RT-4D: ${bin.length} bytes, and the bootloader has room for ${RT4D_MEMORY_SIZE}.`,
    );
  }
  ctx.log(`Firmware size ${bin.length} (0x${bin.length.toString(16)}) bytes`);
  if (bin.length >= 8) {
    // Cortex-M vector table: word 1 is the reset handler, which must lie in the image's region.
    const reset = new DataView(bin.buffer, bin.byteOffset, bin.byteLength).getUint32(4, true);
    if (reset < RT4D_LOAD_ADDRESS || reset >= RT4D_LOAD_ADDRESS + RT4D_MEMORY_SIZE) {
      ctx.log(
        `Warning: this does not look like an image linked for 0x${RT4D_LOAD_ADDRESS.toString(16).padStart(8, '0')} (reset vector 0x${reset.toString(16).padStart(8, '0')}).`,
      );
    }
  }
  // The reference pads with zeros, not 0xFF.
  const image = new Uint8Array(RT4D_MEMORY_SIZE);
  image.set(bin);

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
    const input = new ByteReader(reader);
    const output = writer;

    /** Sends one packet and requires a single ACK byte back. */
    const command = async (bytes: Uint8Array, failure: string): Promise<void> => {
      await output.write(bytes);
      const answer = await input.readByte(responseTimeoutMs);
      if (answer === null) throw new FlashError(`${failure}: the radio did not answer.`);
      if (answer !== ACK_RESPONSE) throw new FlashError(`${failure}: the radio answered ${hex(answer)}.`);
    };

    // check_bootloader_mode(): throw away stale input, then probe with a read command.
    await input.drain(quietMs, 4096);
    await output.write(packet(CMD_READ_FLASH, 0, 0));
    const first = await input.readByte(responseTimeoutMs);
    if (first !== FLASH_MODE_RESPONSE) {
      throw new FlashError(
        first === null
          ? 'The radio did not answer. Is it connected and in flashing mode?'
          : `The radio is not in flashing mode (it answered ${hex(first)}).`,
      );
    }
    // The reference reads up to 4 bytes here and looks only at the first.
    await input.drain(quietMs, 3);
    ctx.log('Radio is in flashing mode');

    // cmd_erase_flash(): two commands, each acknowledged.
    ctx.log('Erasing');
    ctx.progress({ phase: 'erase', done: 0, total });
    await command(packet(CMD_ERASE_FLASH, 0x33, 0x05, 0x10), 'Could not erase the radio memory');
    ctx.progress({ phase: 'erase', done: total / 2, total });
    await command(packet(CMD_ERASE_FLASH, 0x33, 0x05, 0x55), 'Could not erase the radio memory');
    ctx.progress({ phase: 'erase', done: total, total });

    // flash_firmware(): every 1 KiB block of the region, in order.
    ctx.log('Flashing');
    ctx.progress({ phase: 'write', done: 0, total });
    for (let offset = 0; offset < RT4D_MEMORY_SIZE; offset += RT4D_BLOCK_SIZE) {
      // The offset field is the low 16 bits of the byte offset, as in the reference:
      // it wraps every 64 KiB and the bootloader evidently keeps count by itself.
      const block = image.subarray(offset, offset + RT4D_BLOCK_SIZE);
      await command(
        packet(CMD_WRITE_FLASH, (offset >> 8) & 0xff, offset & 0xff, block),
        `Writing failed at 0x${offset.toString(16)}`,
      );
      ctx.progress({ phase: 'write', done: offset + RT4D_BLOCK_SIZE, total });
    }

    ctx.progress({ phase: 'done', done: total, total });
    ctx.log(`Written ${total} (0x${total.toString(16)}) bytes. Switch the radio off and on again.`);
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
