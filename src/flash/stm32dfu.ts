// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Flasher for the STM32 / GD32 ROM bootloader in USB DFU mode (0483:df11, 28e9:0189),
 * and a reader for DfuSe .dfu files.
 *
 * The transfer order (erase, set address, blocks from wBlockNum 2, abort to idle before
 * UPLOAD, zero-length DNLOAD to leave) follows ST's AN3156. The .dfu layout follows
 * ST's UM0391 as implemented by OpenRTX's scripts/dfu-convert.py (LGPL-3.0, Antonio
 * Galea); no code is taken from it.
 */
import { DfuDevice, fallbackLayout, hex32, sectorsTouched, type FlashSector, type Stm32Chip } from './dfu.ts';
import { FlashError, messageOf, type FlashContext, type Segment } from './types.ts';

/** wTransferSize to use when the functional descriptor cannot be read. */
const DEFAULT_TRANSFER_SIZE = 2048;
/** First wBlockNum that carries data; 0 is a command and 1 is reserved. */
const FIRST_DATA_BLOCK = 2;
/** End of the STM32F405's 1 MiB of flash; anything above needs a larger chip. */
const F405_FLASH_END = 0x08100000;

const DFU_PREFIX_SIZE = 11;
const DFU_TARGET_PREFIX_SIZE = 274;
const DFU_SUFFIX_SIZE = 16;

/** Options for flashDfuSe. */
export interface DfuSeOptions {
  /** Leave DFU mode afterwards so the MCU starts the firmware. */
  leave?: boolean;
  /** Address to start at when leaving; defaults to the lowest segment address. */
  leaveAddress?: number;
  /** Chip whose built-in layout to use when the device does not report one. */
  chip?: Stm32Chip;
}

/** Wraps a raw binary as one segment at `address`. */
export function rawSegment(address: number, bytes: Uint8Array): Segment {
  return { address, data: bytes };
}

/** CRC-32 (IEEE, reflected) as used by the DFU file suffix, before the final inversion. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return crc >>> 0;
}

/** ASCII text of a byte range. */
function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

/**
 * Parses a DfuSe v1 .dfu file into the segments it carries. Throws FlashError when the
 * file is truncated, has a bad signature, size or CRC, or targets another alternate
 * setting than 0 (internal flash).
 */
export function parseDfuFile(bytes: Uint8Array): Segment[] {
  const bad = (why: string) => new FlashError(`Not a valid DfuSe .dfu file: ${why}.`);
  if (bytes.length < DFU_PREFIX_SIZE + DFU_SUFFIX_SIZE) throw bad('it is too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(bytes, 0, 5) !== 'DfuSe') throw bad('the "DfuSe" signature is missing');
  if (bytes[5] !== 1) throw bad(`unsupported format version ${bytes[5]}`);

  const suffix = bytes.length - DFU_SUFFIX_SIZE;
  if (ascii(bytes, suffix + 8, 3) !== 'UFD' || bytes[suffix + 11] !== DFU_SUFFIX_SIZE) {
    throw bad('the DFU suffix is missing');
  }
  if (view.getUint32(6, true) !== suffix) throw bad('the image size does not match the file');
  // dwCRC is the CRC-32 register without the usual final inversion.
  if (view.getUint32(suffix + 12, true) !== crc32(bytes.subarray(0, bytes.length - 4))) {
    throw bad('the checksum does not match (corrupt download?)');
  }

  const segments: Segment[] = [];
  let p = DFU_PREFIX_SIZE;
  for (let t = 0; t < bytes[10]; t++) {
    if (p + DFU_TARGET_PREFIX_SIZE > suffix) throw bad(`target ${t} is truncated`);
    if (ascii(bytes, p, 6) !== 'Target') throw bad(`target ${t} has a bad signature`);
    if (bytes[p + 6] !== 0) {
      throw bad(`target ${t} is for alternate setting ${bytes[p + 6]}, only internal flash is supported`);
    }
    const targetSize = view.getUint32(p + 266, true);
    const elements = view.getUint32(p + 270, true);
    p += DFU_TARGET_PREFIX_SIZE;
    const targetEnd = p + targetSize;
    if (targetEnd > suffix) throw bad(`target ${t} is larger than the file`);
    for (let e = 0; e < elements; e++) {
      if (p + 8 > targetEnd) throw bad(`element ${e} of target ${t} is truncated`);
      const address = view.getUint32(p, true);
      const size = view.getUint32(p + 4, true);
      p += 8;
      if (p + size > targetEnd) throw bad(`element ${e} of target ${t} is larger than its target`);
      segments.push({ address, data: bytes.slice(p, p + size) });
      p += size;
    }
    if (p !== targetEnd) throw bad(`target ${t} has data after its last element`);
  }
  if (p !== suffix) throw bad('there is data after the last target');
  if (segments.length === 0) throw bad('it holds no firmware');
  return segments;
}

/** Picks the sector layout: the device's own, else the built-in one for the chip. */
function chooseLayout(
  dfu: DfuDevice,
  segments: Segment[],
  chip: Stm32Chip | undefined,
  ctx: FlashContext,
): FlashSector[] {
  if (dfu.layout) return dfu.layout;
  // The F405 sector boundaries are a superset of the H743's below 1 MiB, so F405 is the
  // safe guess there: every erase still lands on a sector the write needs.
  const guess: Stm32Chip =
    chip ?? (segments.some((s) => s.address + s.data.length > F405_FLASH_END) ? 'h743' : 'f405');
  ctx.log(`The device did not report its flash layout; using the built-in STM32${guess.toUpperCase()} one.`);
  return fallbackLayout(guess);
}

/** Erases every sector the segments touch, once each. */
async function eraseSectors(dfu: DfuDevice, sectors: FlashSector[], ctx: FlashContext) {
  const total = sectors.reduce((sum, s) => sum + s.size, 0);
  let done = 0;
  ctx.log(`Erasing ${sectors.length} flash sector(s), ${total} bytes.`);
  ctx.progress({ phase: 'erase', done, total });
  for (const sector of sectors) {
    if (!sector.erasable || !sector.writable) {
      throw new FlashError(`Flash sector ${hex32(sector.start)} is not writable on this device.`);
    }
    await dfu.eraseSector(sector.start);
    done += sector.size;
    ctx.progress({ phase: 'erase', done, total });
  }
}

/** Number of blocks needed for a segment, checked against the 16-bit wBlockNum. */
function blockCount(segment: Segment, transferSize: number): number {
  const blocks = Math.ceil(segment.data.length / transferSize);
  if (FIRST_DATA_BLOCK + blocks > 0x10000) {
    throw new FlashError(`The segment at ${hex32(segment.address)} is too large for one DFU transfer.`);
  }
  return blocks;
}

/** Writes all segments in wTransferSize blocks. */
async function writeSegments(
  dfu: DfuDevice,
  segments: Segment[],
  transferSize: number,
  total: number,
  ctx: FlashContext,
) {
  let done = 0;
  ctx.progress({ phase: 'write', done, total });
  for (const segment of segments) {
    ctx.log(`Writing ${segment.data.length} bytes at ${hex32(segment.address)}.`);
    await dfu.setAddress(segment.address);
    const blocks = blockCount(segment, transferSize);
    for (let i = 0; i < blocks; i++) {
      const chunk = segment.data.subarray(i * transferSize, (i + 1) * transferSize);
      const at = segment.address + i * transferSize;
      await dfu.writeBlock(FIRST_DATA_BLOCK + i, chunk, `write at ${hex32(at)}`);
      done += chunk.length;
      ctx.progress({ phase: 'write', done, total });
    }
  }
}

/** Reads all segments back with UPLOAD and compares them with what was sent. */
async function verifySegments(
  dfu: DfuDevice,
  segments: Segment[],
  transferSize: number,
  total: number,
  ctx: FlashContext,
) {
  let done = 0;
  ctx.log('Verifying by reading the flash back.');
  ctx.progress({ phase: 'verify', done, total });
  for (const segment of segments) {
    await dfu.setAddress(segment.address);
    await dfu.abortToIdle(); // UPLOAD is only accepted from dfuIDLE; the pointer is kept
    const blocks = blockCount(segment, transferSize);
    for (let i = 0; i < blocks; i++) {
      const want = segment.data.subarray(i * transferSize, (i + 1) * transferSize);
      const at = segment.address + i * transferSize;
      let got: Uint8Array;
      try {
        got = await dfu.upload(FIRST_DATA_BLOCK + i, want.length);
      } catch (e) {
        const why = messageOf(e);
        throw new FlashError(
          `Could not read the flash back at ${hex32(at)} to verify it (is the chip read-protected?): ${why}`,
        );
      }
      if (got.length !== want.length) {
        throw new FlashError(
          `Verify failed at ${hex32(at)}: the device returned ${got.length} of ${want.length} bytes.`,
        );
      }
      const diff = want.findIndex((b, n) => b !== got[n]);
      if (diff >= 0) {
        throw new FlashError(
          `Verify failed at ${hex32(at + diff)}: wrote 0x${hex8(want[diff])}, read back 0x${hex8(got[diff])}.`,
        );
      }
      done += want.length;
      ctx.progress({ phase: 'verify', done, total });
    }
    await dfu.abortToIdle();
  }
}

/** Two-digit hex of a byte. */
function hex8(value: number): string {
  return value.toString(16).padStart(2, '0');
}

/** DfuSe leave: set the address pointer, then a zero-length DNLOAD starts the firmware. */
async function leaveDfu(dfu: DfuDevice, address: number, ctx: FlashContext) {
  ctx.log(`Leaving DFU mode; starting the firmware at ${hex32(address)}.`);
  await dfu.abortToIdle();
  await dfu.setAddress(address);
  await dfu.download(0, new Uint8Array(0));
  try {
    await dfu.getStatus(); // moves the device to dfuMANIFEST; it may drop off the bus first
  } catch {
    // expected: the MCU has already jumped to the firmware
  }
}

/**
 * Reads the whole internal flash through the ROM DfuSe bootloader, for a backup. The
 * result is one segment at the start of the flash, which `flashDfuSe` can write back.
 * A read-protected chip refuses, and the error says so.
 */
export async function readDfuSe(
  dev: USBDevice,
  ctx: FlashContext,
  opts: DfuSeOptions = {},
): Promise<Segment> {
  const dfu = await DfuDevice.open(dev, ctx);
  try {
    const reported = dfu.functional?.transferSize ?? 0;
    const transferSize = reported > 0 ? reported : DEFAULT_TRANSFER_SIZE;
    if (!dfu.layout) {
      ctx.log(
        `The device did not report its flash layout; using the built-in STM32${(opts.chip ?? 'f405').toUpperCase()} one.`,
      );
    }
    const sectors = [...(dfu.layout ?? fallbackLayout(opts.chip ?? 'f405'))].sort(
      (a, b) => a.start - b.start,
    );
    // Take the sectors that follow each other from the start of the flash; ST's layout
    // strings also list option bytes and the like, which are not firmware.
    const flash = sectors.filter((s, i) => i === 0 || s.start === sectors[i - 1].start + sectors[i - 1].size);
    const start = flash[0].start;
    const total = flash.reduce((sum, s) => sum + s.size, 0);
    const image = new Uint8Array(total);
    ctx.log(`Reading ${total} bytes of flash from ${hex32(start)}.`);
    ctx.progress({ phase: 'read', done: 0, total });
    let done = 0;
    for (const sector of flash) {
      await dfu.abortToIdle();
      await dfu.setAddress(sector.start);
      await dfu.abortToIdle(); // UPLOAD is only accepted from dfuIDLE; the pointer is kept
      for (let offset = 0; offset < sector.size; offset += transferSize) {
        const length = Math.min(transferSize, sector.size - offset);
        let got: Uint8Array;
        try {
          got = await dfu.upload(FIRST_DATA_BLOCK + offset / transferSize, length);
        } catch (e) {
          const why = messageOf(e);
          throw new FlashError(
            `The radio would not let its flash be read at ${hex32(sector.start + offset)}. ` +
              `Its chip is probably read-protected, so it cannot be backed up this way. (${why})`,
          );
        }
        if (got.length !== length) {
          throw new FlashError(
            `Reading stopped at ${hex32(sector.start + offset)}: the device returned ${got.length} of ${length} bytes.`,
          );
        }
        image.set(got, sector.start - start + offset);
        done += length;
        ctx.progress({ phase: 'read', done, total });
      }
    }
    await dfu.abortToIdle();
    ctx.log(`Read ${total} bytes.`);
    return { address: start, data: image };
  } finally {
    await dfu.close();
  }
}

/**
 * Flashes segments through the STM32 / GD32 ROM DfuSe bootloader: erases the sectors
 * they touch, writes, reads back and compares, and optionally leaves DFU mode.
 */
export async function flashDfuSe(
  dev: USBDevice,
  segments: Segment[],
  ctx: FlashContext,
  opts: DfuSeOptions = {},
): Promise<void> {
  const total = segments.reduce((sum, s) => sum + s.data.length, 0);
  if (total === 0) throw new FlashError('There is no firmware to write.');
  ctx.progress({ phase: 'connect', done: 0, total });
  const dfu = await DfuDevice.open(dev, ctx);
  try {
    // A transfer size of 0 is as useless as a missing one.
    const reported = dfu.functional?.transferSize ?? 0;
    const transferSize = reported > 0 ? reported : DEFAULT_TRANSFER_SIZE;
    const layout = chooseLayout(dfu, segments, opts.chip, ctx);
    const sectors = new Map<number, FlashSector>();
    for (const segment of segments) {
      for (const s of sectorsTouched(layout, segment.address, segment.data.length)) {
        sectors.set(s.start, s);
      }
    }
    ctx.log(`Connected to ${dev.productName ?? 'DFU device'}; ${transferSize}-byte blocks.`);

    await dfu.abortToIdle();
    await eraseSectors(
      dfu,
      [...sectors.values()].sort((a, b) => a.start - b.start),
      ctx,
    );
    await writeSegments(dfu, segments, transferSize, total, ctx);
    await verifySegments(dfu, segments, transferSize, total, ctx);
    ctx.log(`Wrote and verified ${total} bytes.`);
    if (opts.leave) {
      const lowest = Math.min(...segments.map((s) => s.address));
      await leaveDfu(dfu, opts.leaveAddress ?? lowest, ctx);
    }
    ctx.progress({ phase: 'done', done: total, total });
  } finally {
    await dfu.close();
  }
}
