// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Read-only backup of a TYT-family radio (MD-380/MD-390, MD-UV380/MD-UV390, MD-9600,
 * DM-1701) through its original firmware, in normal mode.
 *
 * In normal mode these radios are a DFU device with the bootloader's USB IDs
 * (0483:df11): the device the vendor's programming software talks to. A few of its
 * commands only read. They give what cannot be downloaded again once OpenRTX is on the
 * radio: the factory info blocks, the first 64 KB of the MCU flash (the bootloader) and
 * the SPI flash (codeplug, settings, resources).
 *
 * This is a port of RadioFoundry's origbackup.js and origversion.js
 * (https://github.com/RadioFoundry/RadioFoundry, site/static/js/flasher; MIT,
 * Copyright (c) 2026 The RadioFoundry Authors): the allowlist, the request sequences
 * and their order. What the radio answers is in RadioFoundry's
 * docs/spec/hardware-md9600.md 15.1 and 15.2, measured on an MD-9600. The codeplug
 * ranges of the other models are those dmrconfig (BSD-3-Clause: md380.c, uv380.c,
 * dfu-libusb.c) and qdmr (GPL-3.0: lib/md390_codeplug.cc, uv390_codeplug.cc,
 * dm1701_codeplug.cc, tyt_interface.cc) read.
 *
 * Every request goes through TytStockGuard, an allowlist: GETSTATUS, CLRSTATUS, ABORT,
 * UPLOAD, and DNLOAD of block 0 with exactly `A2 ss`, `21` + a 32-bit address, `91 01`
 * or `91 05`. Anything else throws before it is sent: no erase, no write, no
 * zero-length DNLOAD (the original firmware's manifest step writes its SPI flash and
 * restarts), no other vendor command.
 *
 * The order matters. The internal flash is readable only before program mode (`91 01`):
 * an UPLOAD of block 2 then answers from 0x08000000 whatever the block number, so one
 * request is one snapshot, as large as the host allows. The SPI flash is readable only
 * in program mode, which the original firmware leaves only by restarting (`91 05`).
 */
import { hexSpaced } from '../bytes.ts';
import { DfuDevice, DfuState, dfuStateName, hex32, type DfuStatus } from '../flash/dfu.ts';
import { FlashError, messageOf, type FlashContext } from '../flash/types.ts';
import type { AlreadyBackedUp, BackupPart, BackupScope, Known, RadioBackup } from './types.ts';

/** Radio families this reader knows. */
export type TytStockModel = 'md3x0' | 'mduv3x0' | 'md9600' | 'dm1701';

/** A byte range of the SPI flash. */
export interface TytStockRange {
  address: number;
  length: number;
}

/** What to read from one model. */
export interface TytStockPlan {
  /** Info block codes (`A2 ss`), in the order read. */
  info: readonly number[];
  /** The most to ask for in the one snapshot of the internal flash (at most 65535). */
  snapshot: number;
  /** Bytes of SPI flash that scope 'all' reads, from address 0. */
  spiSize: number;
  /** The codeplug areas that scope 'quick' reads; multiples of 1024 bytes. */
  quick: readonly TytStockRange[];
  /** True when this plan was measured on a real radio of this model. */
  checked: boolean;
}

/** Bytes per UPLOAD in program mode, and the most asked of an info block. */
const BLOCK = 1024;
const INTERNAL_FLASH_BASE = 0x08000000;
/** Snapshot sizes, largest first: Windows and macOS pass 65535, Linux caps at 4096. */
const SNAPSHOT_SIZES = [65535, 32768, 16384, 8192, 4096];
/** Slowest measured speed of the SPI read (RadioFoundry: 346 s for 16 MB); it can be faster. */
const SPI_BYTES_PER_SECOND = 47000;

const CMD_INFO = 0xa2;
const CMD_SET_ADDRESS = 0x21;
const CMD_VENDOR = 0x91;
const VENDOR_PROGRAM_MODE = 0x01;
const VENDOR_RESTART = 0x05;
const INFO_VERSION = 0x02;
const INFO_UID = 0x07;

/** Alt 0 of the original firmware and of the bootloader (hardware-md9600.md 15.1). */
const ORIGINAL_INTERFACE = '@Internal Flash /0x08000000/03*016Kg';
const BOOTLOADER_INTERFACE = '@Internal Flash /0x0800C000/01*016Kg,01*064Kg,07*128Kg';

/**
 * Info blocks of the MD-9600: 02 version, 01 and 03 option block, 04 settings,
 * 05 calibration as loaded in RAM, 07 UID, 08 clock, 32 UID record and OTP area,
 * 33 SPI region table and radio name, 50 a constant.
 */
const INFO_CODES = [0x02, 0x01, 0x03, 0x04, 0x05, 0x07, 0x08, 0x32, 0x33, 0x50];
/** W25Q128, on all four models. Some early VHF MD-380s have a 1 MB chip. */
const SPI_SIZE = 0x1000000;
/** Codeplug of the single-band radios: dmrconfig md380.c MEMSZ; qdmr 0x2000-0x3ffff. */
const CODEPLUG_LOW: TytStockRange = { address: 0, length: 0x40000 };
/** Second codeplug area of the dual-band radios: dmrconfig uv380.c, qdmr uv390/dm1701. */
const CODEPLUG_HIGH: TytStockRange = { address: 0x110000, length: 0x90000 };

/**
 * The plan per model. Only the MD-9600's was measured on a radio (RadioFoundry
 * hardware-md9600.md 15.2, and again on a second MD-9600). Its quick read is the first
 * 2 MB in one run, as measured; it covers both codeplug areas.
 *
 * Assumed for the other three: that their original firmware answers the same info
 * codes, gives the same snapshot of internal flash before program mode and reads all
 * 16 MB of SPI flash in program mode, since they share the bootloader, the normal-mode
 * interface string and the vendor's programming protocol. Their quick ranges are the
 * codeplug areas dmrconfig and qdmr read, widened to start at 0 as dmrconfig does, and
 * reached as both do: address 0 once, then block 2 + address / 1024.
 */
export const TYT_STOCK_PLANS: Readonly<Record<TytStockModel, TytStockPlan>> = {
  md9600: {
    info: INFO_CODES,
    snapshot: 65535,
    spiSize: SPI_SIZE,
    quick: [{ address: 0, length: 0x200000 }],
    checked: true,
  },
  md3x0: { info: INFO_CODES, snapshot: 65535, spiSize: SPI_SIZE, quick: [CODEPLUG_LOW], checked: false },
  mduv3x0: {
    info: INFO_CODES,
    snapshot: 65535,
    spiSize: SPI_SIZE,
    quick: [CODEPLUG_LOW, CODEPLUG_HIGH],
    checked: false,
  },
  dm1701: {
    info: INFO_CODES,
    snapshot: 65535,
    spiSize: SPI_SIZE,
    quick: [CODEPLUG_LOW, CODEPLUG_HIGH],
    checked: false,
  },
};

/** A request outside the allowlist; it was not sent. */
export class TytStockRefused extends FlashError {
  /** Error naming the request that was refused. */
  constructor(request: string) {
    super(`Refused to send ${request} to the radio: a backup only reads.`);
    this.name = 'TytStockRefused';
  }
}

/** The DFU requests the guard passes on; DfuDevice is one. */
export type TytStockTransport = Pick<
  DfuDevice,
  'download' | 'upload' | 'getStatus' | 'clearStatus' | 'abort'
>;

/**
 * The allowlist in front of the device. It has no method for DETACH or GETSTATE, and
 * refuses every DNLOAD and UPLOAD the backup does not need before it is sent.
 */
export class TytStockGuard {
  private programModeSent = false;

  /** Guards `transport`; `original` is false for a bootloader, which never gets `91 05`. */
  constructor(
    private readonly transport: TytStockTransport,
    private readonly original: boolean,
  ) {}

  /** True once `91 01` has been sent: UPLOAD then reads SPI flash, 1024 bytes at most. */
  get programMode(): boolean {
    return this.programModeSent;
  }

  /** Whether `data` is a block 0 command the backup may send. */
  allowedCommand(data: Uint8Array): boolean {
    if (data.length === 2 && data[0] === CMD_INFO) return true;
    if (data.length === 5 && data[0] === CMD_SET_ADDRESS) return true;
    if (data.length !== 2 || data[0] !== CMD_VENDOR) return false;
    return data[1] === VENDOR_PROGRAM_MODE || (this.original && data[1] === VENDOR_RESTART);
  }

  /** DNLOAD: block 0 with an allowed command only. */
  async download(blockNum: number, data: Uint8Array): Promise<void> {
    if (blockNum !== 0 || data.length === 0 || !this.allowedCommand(data)) {
      throw new TytStockRefused(`DNLOAD block ${blockNum}, ${data.length} bytes [${hexBytes(data, 8)}]`);
    }
    if (data[0] === CMD_VENDOR && data[1] === VENDOR_PROGRAM_MODE) this.programModeSent = true;
    await this.transport.download(0, data);
  }

  /**
   * UPLOAD: never block 1; up to 1024 bytes, or the one snapshot of block 2 (up to
   * 65535 bytes) before program mode.
   */
  async upload(blockNum: number, length: number): Promise<Uint8Array> {
    const whole = Number.isInteger(blockNum) && Number.isInteger(length);
    const snapshot = blockNum === 2 && !this.programModeSent && length <= 65535;
    const ok =
      whole &&
      blockNum >= 0 &&
      blockNum <= 0xffff &&
      blockNum !== 1 &&
      length >= 1 &&
      (length <= BLOCK || snapshot);
    if (!ok) throw new TytStockRefused(`UPLOAD block ${blockNum}, ${length} bytes`);
    return this.transport.upload(blockNum, length);
  }

  /** GETSTATUS. */
  async getStatus(): Promise<DfuStatus> {
    return this.transport.getStatus();
  }

  /** CLRSTATUS. */
  async clearStatus(): Promise<void> {
    await this.transport.clearStatus();
  }

  /** ABORT. */
  async abort(): Promise<void> {
    await this.transport.abort();
  }
}

/** Which device an alt 0 interface string shows. */
export type TytStockDeviceKind = 'original' | 'bootloader';

/**
 * Tells the original firmware from the bootloader by the alt 0 interface string, spaces
 * not counted. Null for any other string and for none.
 */
export function tytStockDeviceKind(interfaceName: string | null): TytStockDeviceKind | null {
  const name = squeeze(interfaceName ?? '');
  if (name === ORIGINAL_INTERFACE) return 'original';
  if (name === BOOTLOADER_INTERFACE) return 'bootloader';
  return null;
}

/**
 * Version text of an `A2 02` answer as the radio's menu shows it: the variant letter
 * (V, P, S, D), then six decimal digits, `44 01 30 20` = "D013.020". Null for anything
 * else and for the bootloader's answer, which starts with 'T'.
 *
 * RadioFoundry's parseVersion takes only 'V' with a two-digit major and prints
 * `56 00 60 09` as "06.09". A second MD-9600 answered another letter and a three-digit
 * major, so the letter and all six digits are kept here.
 */
export function parseTytVersion(data: Uint8Array | undefined): string | null {
  if (data?.length !== 4) return null;
  const letter = data[0];
  if (letter < 0x41 || letter > 0x5a || letter === 0x54) return null;
  const digits = [...data.subarray(1)].flatMap((b) => [b >> 4, b & 15]);
  if (digits.some((d) => d > 9)) return null;
  return `${String.fromCharCode(letter)}${digits.slice(0, 3).join('')}.${digits.slice(3).join('')}`;
}

/** Collapses runs of white space, as RadioFoundry compares interface strings. */
function squeeze(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(' ');
}

/** Bytes as "a2 07", at most `limit` of them. */
function hexBytes(data: Uint8Array, limit = data.length): string {
  return hexSpaced(data.subarray(0, limit));
}

/** A code or byte as two hex digits. */
function hex2(value: number): string {
  return value.toString(16).padStart(2, '0');
}

/** An SPI flash address as six hex digits. */
function hex6(value: number): string {
  return value.toString(16).padStart(6, '0');
}

/** Text of a thrown value, without a final full stop so it fits inside a sentence. */
function reasonOf(e: unknown): string {
  return messageOf(e).replace(/\.$/, '');
}

/** Rethrows a guard refusal: that is a bug in this file, never a reading error. */
function rethrowRefused(e: unknown): void {
  if (e instanceof TytStockRefused) throw e;
}

/** Brings the device to dfuIDLE: CLRSTATUS in dfuERROR, ABORT in any other state. */
async function toIdle(g: TytStockGuard): Promise<void> {
  const { state } = await g.getStatus();
  if (state === DfuState.dfuERROR) await g.clearStatus();
  else if (state !== DfuState.dfuIDLE) await g.abort();
}

/**
 * A block 0 command: DNLOAD, GETSTATUS (dfuDNBUSY: it runs after this reply), GETSTATUS
 * (dfuDNLOAD-IDLE), ABORT. No waiting in between, as measured.
 */
async function command(g: TytStockGuard, bytes: readonly number[]): Promise<void> {
  await g.download(0, Uint8Array.from(bytes));
  const busy = await g.getStatus();
  const done = await g.getStatus();
  const ok =
    busy.status === 0 &&
    busy.state === DfuState.dfuDNBUSY &&
    done.status === 0 &&
    done.state === DfuState.dfuDNLOAD_IDLE;
  if (!ok) {
    throw new FlashError(
      `the radio did not take command ${hexBytes(Uint8Array.from(bytes))} ` +
        `(DFU states ${dfuStateName(busy.state)}, ${dfuStateName(done.state)})`,
    );
  }
  await g.abort();
}

/** One info block: `A2 ss`, then UPLOAD of block 0. */
async function readInfo(g: TytStockGuard, code: number): Promise<Uint8Array> {
  await command(g, [CMD_INFO, code]);
  return g.upload(0, BLOCK);
}

/**
 * One snapshot of the internal flash from 0x08000000, before program mode: the largest
 * size the host passes. Null when no size worked.
 */
async function readSnapshot(g: TytStockGuard, max: number, ctx: FlashContext): Promise<Uint8Array | null> {
  for (const size of SNAPSHOT_SIZES.filter((n) => n <= max)) {
    try {
      const data = await g.upload(2, size);
      await g.abort();
      if (data.length > 0) return data;
    } catch (e) {
      rethrowRefused(e);
      ctx.log(`A read of ${size} bytes of internal flash did not pass: ${reasonOf(e)}.`);
      await toIdle(g).catch(() => {});
    }
  }
  return null;
}

/** What was read of one SPI range, and why the read stopped early, if it did. */
interface SpiRead {
  data: Uint8Array;
  stopped: string | null;
}

/**
 * Reads one SPI range in 1024-byte blocks, block 2 + address / 1024 with the address
 * pointer at 0. Keeps what arrived when the radio refuses a block or cuts one short.
 */
async function readSpiRange(
  g: TytStockGuard,
  range: TytStockRange,
  onBytes: (count: number) => void,
): Promise<SpiRead> {
  const out = new Uint8Array(range.length);
  const first = 2 + range.address / BLOCK;
  let got = 0;
  for (let i = 0; got < range.length; i++) {
    let block: Uint8Array;
    try {
      block = await g.upload(first + i, BLOCK);
    } catch (e) {
      rethrowRefused(e);
      return { data: out.slice(0, got), stopped: reasonOf(e) };
    }
    const count = Math.min(block.length, range.length - got);
    out.set(block.subarray(0, count), got);
    got += count;
    onBytes(count);
    if (block.length !== BLOCK) {
      const stopped = `the radio sent ${block.length} bytes of a ${BLOCK}-byte block`;
      return { data: out.slice(0, got), stopped };
    }
  }
  return { data: out, stopped: null };
}

/**
 * `91 05`: the original firmware restarts before it answers the next GETSTATUS, so a
 * GETSTATUS that fails is the success. False when the radio is still there.
 */
async function restart(g: TytStockGuard): Promise<boolean> {
  try {
    await g.download(0, Uint8Array.of(CMD_VENDOR, VENDOR_RESTART));
  } catch (e) {
    rethrowRefused(e);
    return false;
  }
  for (let i = 0; i < 2; i++) {
    try {
      await g.getStatus();
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * The 96-bit UID in info block 07 as hex; null when the block is missing or blank. The
 * UID follows four bytes RadioFoundry calls its CRC-32. They are not checked: on a radio
 * they did not match a plain CRC-32 of the UID.
 */
function uidOf(block: Uint8Array | undefined): string | null {
  if (!block || block.length < 16) return null;
  const uid = block.subarray(4, 16);
  if (uid.every((b) => b === 0xff) || uid.every((b) => b === 0)) return null;
  return [...uid].map(hex2).join('');
}

/** A size for the log: "16 MB", "256 KB". */
function sizeText(bytes: number): string {
  return bytes % 0x100000 === 0 ? `${bytes / 0x100000} MB` : `${Math.round(bytes / 1024)} KB`;
}

/** The backup part for the snapshot of the internal flash; `data` is empty when no read passed. */
function snapshotPart(data: Uint8Array, planned: number): BackupPart {
  const complete = data.length >= planned;
  return {
    file: `bootloader-${data.length}.bin`,
    kind: 'internal-flash',
    address: INTERNAL_FLASH_BASE,
    data,
    complete,
    note: complete
      ? 'The first 64 KB of the MCU flash less its last byte: the bootloader, then the start of the firmware.'
      : data.length === 0
        ? 'The start of the internal flash (the bootloader) could not be read: the radio or this ' +
          'computer passed no read of it, at any size.'
        : `Only the first ${data.length} of ${planned} bytes: this computer limits the size of one USB ` +
          'read (Linux allows 4096 bytes). Back up on Windows or macOS to save the whole bootloader.',
  };
}

/** The backup part for one SPI range. */
function spiPart(range: TytStockRange, read: SpiRead, scope: BackupScope): BackupPart {
  const part: BackupPart = {
    file: scope === 'all' ? 'spi-flash.bin' : `spi-flash-${hex6(range.address)}.bin`,
    kind: 'spi-flash',
    address: range.address,
    data: read.data,
    complete: read.stopped === null,
  };
  if (read.stopped !== null) {
    part.note = `The read stopped after ${read.data.length} of ${range.length} bytes: ${read.stopped}.`;
  }
  return part;
}

/** The SPI ranges a scope reads. */
function spiRanges(plan: TytStockPlan, scope: BackupScope): readonly TytStockRange[] {
  return scope === 'all' ? [{ address: 0, length: plan.spiSize }] : plan.quick;
}

/**
 * Bytes a backup plans to read, for the progress bar. An info block counts as the 1024
 * bytes asked for, since its real size is not known ahead.
 */
function plannedBytes(plan: TytStockPlan, scope: BackupScope): number {
  const spiBytes = spiRanges(plan, scope).reduce((sum, r) => sum + r.length, 0);
  return plan.info.length * BLOCK + plan.snapshot + spiBytes;
}

/** The whole read from the original firmware, through the guard. */
async function readOriginal(
  g: TytStockGuard,
  plan: TytStockPlan,
  scope: BackupScope,
  ctx: FlashContext,
  known?: Known,
): Promise<RadioBackup | AlreadyBackedUp> {
  const ranges = spiRanges(plan, scope);
  const total = plannedBytes(plan, scope);
  const spiBytes = total - plan.info.length * BLOCK - plan.snapshot;
  const parts: BackupPart[] = [];
  const notes: string[] = [];
  let done = 0;
  const advance = (count: number) => {
    done += count;
    ctx.progress({ phase: 'read', done, total });
  };
  const tell = (text: string) => {
    notes.push(text);
    ctx.log(text);
  };

  ctx.progress({ phase: 'read', done: 0, total });
  await toIdle(g);

  const infos = new Map<number, Uint8Array>();
  const missing: string[] = [];
  for (const code of plan.info) {
    let why = 'the radio answered with nothing';
    try {
      const data = await readInfo(g, code);
      if (data.length > 0) infos.set(code, data);
    } catch (e) {
      rethrowRefused(e);
      why = reasonOf(e);
      ctx.log(`Info block ${hex2(code)}: ${why}.`);
      await toIdle(g).catch(() => {});
    }
    const data = infos.get(code);
    const file = `info-${hex2(code)}.bin`;
    if (data) {
      parts.push({ file, kind: 'info', data, complete: true });
    } else {
      // Listed all the same: a backup that lacks a planned part must not look whole.
      const note = `This info block could not be read: ${why}.`;
      parts.push({ file, kind: 'info', data: new Uint8Array(0), complete: false, note });
      missing.push(hex2(code));
    }
    advance(BLOCK);
  }
  if (missing.length > 0) tell(`The radio did not give info block ${missing.join(', ')}.`);
  ctx.log(`Read ${infos.size} of ${plan.info.length} factory info blocks.`);

  const firmware = parseTytVersion(infos.get(INFO_VERSION)) ?? undefined;
  const radioId = uidOf(infos.get(INFO_UID));
  ctx.log(firmware ? `Original firmware version ${firmware}.` : 'The radio gave no firmware version.');
  if (radioId !== null && known?.(radioId)) {
    // Program mode was not entered, so the radio carries on as it was.
    ctx.log('This radio already has a backup; not reading it again.');
    return { known: radioId };
  }

  const snapshot = await readSnapshot(g, plan.snapshot, ctx);
  const snapshotted = snapshotPart(snapshot ?? new Uint8Array(0), plan.snapshot);
  parts.push(snapshotted);
  if (snapshot) {
    ctx.log(`Read ${snapshot.length} bytes of internal flash from ${hex32(INTERNAL_FLASH_BASE)}.`);
    if (!snapshotted.complete && snapshotted.note) tell(`Bootloader: ${snapshotted.note}`);
  } else {
    tell('The start of the internal flash (the bootloader) could not be read.');
  }
  advance(plan.snapshot);

  const minutes = Math.max(1, Math.round(spiBytes / SPI_BYTES_PER_SECOND / 60));
  ctx.log(`Reading ${sizeText(spiBytes)} of SPI flash, up to about ${minutes} min.`);
  ctx.log('The radio stops normal operation until it restarts at the end.');
  let stopped: string | null = null;
  let restarted = false;
  try {
    try {
      await command(g, [CMD_VENDOR, VENDOR_PROGRAM_MODE]);
      await command(g, [CMD_SET_ADDRESS, 0, 0, 0, 0]);
    } catch (e) {
      rethrowRefused(e);
      stopped = reasonOf(e);
    }
    let read = 0;
    for (const range of ranges) {
      // Once the read has stopped, what is left is not tried. It is listed all the same,
      // empty: a backup that lacks a planned part must not look whole.
      const r: SpiRead =
        stopped === null ? await readSpiRange(g, range, advance) : { data: new Uint8Array(0), stopped };
      parts.push(spiPart(range, r, scope));
      read += r.data.length;
      stopped = r.stopped;
    }
    if (stopped === null) {
      await g.abort().catch(() => {});
    } else {
      await toIdle(g).catch(() => {});
      tell(`The SPI flash read stopped early, with ${read} of ${spiBytes} bytes: ${stopped}.`);
    }
  } finally {
    // The original firmware leaves program mode only by restarting.
    if (g.programMode) restarted = await restart(g);
  }
  if (restarted) {
    ctx.log('Sent the restart command (91 05): the radio restarts and runs normally again.');
  } else {
    tell('The radio did not restart by itself. Switch it off and on again.');
  }

  if (parts.every((part) => part.data.length === 0)) {
    throw new FlashError(
      'Nothing could be read from the radio. Switch it off and on again, check the cable and retry.',
    );
  }
  ctx.progress({ phase: 'done', done: total, total });
  return { radioId, idKind: radioId === null ? null : 'uid', firmware, parts, notes };
}

/**
 * Reads a TYT-family radio through its original firmware without changing anything on
 * it: the info blocks, one snapshot of the start of the internal flash, then the SPI
 * flash (all of it, or the codeplug areas for scope 'quick'), then `91 05` so the radio
 * restarts. A part the radio refuses or cuts short is kept, marked incomplete; every
 * planned part is in the result, one that could not be read at all as an empty part with
 * a note that says why.
 *
 * `known` is asked once the info blocks have given the radio's ID. When it says the
 * radio is already backed up, the read ends there: program mode is never entered and
 * the radio does not restart.
 *
 * The radio must be in normal mode. In flashing mode (the bootloader)
 * this refuses without sending a request: what the bootloader gives is known from its
 * code only, not from a radio, and it is the first megabyte at most.
 */
export async function readTytStock(
  dev: USBDevice,
  model: TytStockModel,
  scope: BackupScope,
  ctx: FlashContext,
): Promise<RadioBackup>;
export async function readTytStock(
  dev: USBDevice,
  model: TytStockModel,
  scope: BackupScope,
  ctx: FlashContext,
  known: Known | undefined,
): Promise<RadioBackup | AlreadyBackedUp>;
export async function readTytStock(
  dev: USBDevice,
  model: TytStockModel,
  scope: BackupScope,
  ctx: FlashContext,
  known?: Known,
): Promise<RadioBackup | AlreadyBackedUp> {
  const plan = TYT_STOCK_PLANS[model];
  ctx.progress({ phase: 'connect', done: 0, total: plannedBytes(plan, scope) });
  const dfu = await DfuDevice.open(dev, ctx);
  try {
    const kind = dfu.alternateSetting === 0 ? tytStockDeviceKind(dfu.interfaceName) : null;
    if (kind === 'bootloader') {
      throw new FlashError(
        'The radio is in flashing mode. A backup needs it in normal mode: ' +
          'turn it off, turn it on again without holding any key, and retry. Nothing was sent to it.',
      );
    }
    if (kind === null) {
      throw new FlashError(
        'This is not a radio running its original firmware, so nothing was sent to it. ' +
          `(It reported "${dfu.interfaceName ?? 'no layout'}".)`,
      );
    }
    ctx.log('The radio runs its original firmware. Reading it changes nothing on the radio.');
    const backup = await readOriginal(new TytStockGuard(dfu, true), plan, scope, ctx, known);
    if ('known' in backup) return backup;
    if (!plan.checked) {
      backup.notes.push(
        'This way of reading was measured on an MD-9600 only. On this model it has not been checked ' +
          'on a radio yet: keep a codeplug read with the programming software as well.',
      );
    }
    return backup;
  } finally {
    await dfu.close();
  }
}
