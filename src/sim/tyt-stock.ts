// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Simulated TYT radio as a read-only backup sees it: the original firmware switched on
 * normally, or the bootloader, both USB 0483:df11.
 *
 * Modelled on the fake radio of RadioFoundry (site/static/js/flasher/fake.js, MIT,
 * Copyright (c) 2026 The RadioFoundry Authors) and on its hardware-md9600.md 15.1 and
 * 15.2: a mode byte that `91 01` raises to program mode; an UPLOAD of block 2 and up
 * that answers the internal flash from 0x08000000 below program mode, whatever the
 * block number, and the SPI flash in it; the bootloader's first megabyte only, a stale
 * buffer above; a restart on `91 05` before the next GETSTATUS is answered.
 *
 * It is strict. A request outside the backup's allowlist is listed in `forbidden` and
 * stalled, and a request in the wrong DFU state stalls and leaves the device in
 * dfuERROR. Memory contents are pseudo-random from a seed, so tests compare what a
 * backup read with `flash`, `spi` and `infoBlock()` byte for byte.
 */
import { hexSpaced } from '../bytes.ts';
import { SimStall, SimUsbDevice, type SimDfuStatus } from './usb.ts';

const IDLE = 2;
const DNLOAD_SYNC = 3;
const DNBUSY = 4;
const DNLOAD_IDLE = 5;
const UPLOAD_IDLE = 9;
const ERROR = 10;
const ERR_STALLEDPKT = 0x0f;

const REQUEST_DNLOAD = 1;
const REQUEST_UPLOAD = 2;
const REQUEST_GETSTATUS = 3;
const REQUEST_CLRSTATUS = 4;
const REQUEST_ABORT = 6;

const BLOCK = 1024;
/** Value of the mode byte in program mode. */
const PROGRAM_MODE = 0x30;
/** The bootloader reads the first megabyte of SPI flash only. */
const BOOTLOADER_SPI_LIMIT = 0x100000;
/** Sizes of the info blocks the original firmware answers; any other code is the version. */
const INFO_SIZES: Readonly<Record<number, number>> = {
  0x01: 32,
  0x03: 24,
  0x04: 8,
  0x05: 512,
  0x07: 16,
  0x08: 7,
  0x32: 561,
  0x33: 64,
  0x50: 8,
};
/** Info blocks the bootloader answers blank. */
const BOOTLOADER_BLANK = [0x01, 0x03, 0x04, 0x05];

/** Which firmware answers. */
export type SimTytStockMode = 'original' | 'bootloader';

/** Options for the simulated radio. */
export interface SimTytStockOptions {
  mode?: SimTytStockMode;
  /** Size of the SPI flash; 16 MB when left out. */
  spiSize?: number;
  /** Largest control IN the "host" passes; Linux has 4096. 0 for no limit. */
  usbCap?: number;
  /** The four bytes the original firmware answers to `A2 02`. */
  version?: Uint8Array;
  /** The 96-bit UID; null for a blank one (all 0xff). */
  uid?: Uint8Array | null;
  /** Seed of the memory contents. */
  seed?: number;
  /** Names of the alternate settings, to simulate some other DFU device. */
  alternateNames?: (string | null)[];
  /** When false the browser gives no interface names and the host reads the descriptors. */
  exposeInterfaceNames?: boolean;
}

/** Deterministic pseudo-random bytes (xorshift32). */
function pseudoRandom(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < length; i += 4) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    // Writes past the end of a typed array are dropped.
    out[i] = s;
    out[i + 1] = s >>> 8;
    out[i + 2] = s >>> 16;
    out[i + 3] = s >>> 24;
  }
  return out;
}

/** Bytes as "91 01". */
function hexBytes(data: Uint8Array): string {
  return hexSpaced(data.subarray(0, 16));
}

/** Simulated TYT radio for the read-only backup, original firmware or bootloader. */
export class SimTytStock extends SimUsbDevice {
  readonly mode: SimTytStockMode;
  /** The first 64 KB of the MCU flash: the bootloader, then the start of the firmware. */
  readonly flash: Uint8Array;
  /** The whole SPI flash. */
  readonly spi: Uint8Array;
  /** The 96-bit UID, bytes 4 to 15 of info block 07. */
  readonly uid: Uint8Array;
  /** Every request outside the backup's allowlist that reached the radio. */
  readonly forbidden: string[] = [];
  /** Payload of every DNLOAD that reached the radio, as hex, in order. */
  readonly commands: string[] = [];
  /** Times the original firmware restarted on `91 05`. */
  restarts = 0;
  /** An UPLOAD in program mode that covers this SPI address stalls. */
  stallSpiAt: number | null = null;
  /** An UPLOAD in program mode that covers this SPI address stops just before it. */
  shortSpiAt: number | null = null;
  /** Info codes whose `A2 ss` command stalls. */
  stallInfo: number[] = [];
  /** When true, `91 01` stalls: the radio does not enter program mode. */
  refuseProgramMode = false;

  private readonly usbCap: number;
  private readonly version: Uint8Array;
  private readonly seed: number;
  private state = IDLE;
  /** The firmware's mode byte: 0 after a start, 0x30 in program mode. */
  private modeByte = 0;
  /** `A2 ss`: the info block the next UPLOAD of block 0 answers. */
  private selector: number | null = null;
  private pointer = 0;
  private pendingRestart = false;
  private stale: Uint8Array = new Uint8Array(BLOCK);

  /** Builds a radio that has just started, in dfuIDLE. */
  constructor(options: SimTytStockOptions = {}) {
    const mode = options.mode ?? 'original';
    const spiName = '@SPI Flash Memory /0x00000000/16*064Kg';
    super({
      vendorId: 0x0483,
      productId: 0xdf11,
      productName: 'Digital Radio in USB mode',
      manufacturerName: 'AnyRoad Technology',
      transferSize: BLOCK,
      alternateNames:
        options.alternateNames ??
        (mode === 'original'
          ? ['@Internal Flash   /0x08000000/03*016Kg', spiName]
          : ['@Internal Flash   /0x0800C000/01*016Kg,01*064Kg,07*128Kg', spiName]),
      exposeInterfaceNames: options.exposeInterfaceNames,
    });
    this.mode = mode;
    this.seed = options.seed ?? 9600;
    this.usbCap = options.usbCap ?? 0;
    this.version = options.version ?? Uint8Array.of(0x56, 0x00, 0x60, 0x09);
    this.flash = pseudoRandom(0x10000, this.seed + 1);
    this.spi = pseudoRandom(options.spiSize ?? 0x1000000, this.seed + 2);
    this.uid =
      options.uid === null ? new Uint8Array(12).fill(0xff) : (options.uid ?? pseudoRandom(12, this.seed + 3));
  }

  /** True in program mode: UPLOAD reads the SPI flash. */
  get programMode(): boolean {
    return this.modeByte >= PROGRAM_MODE;
  }

  /** Info block `code` as this device answers `A2 ss` and an UPLOAD of block 0. */
  infoBlock(code: number): Uint8Array {
    const loader = this.mode === 'bootloader';
    const size = INFO_SIZES[code];
    if (size === undefined) return loader ? Uint8Array.of(0x54, 0x02, 0x10, 0x06) : this.version.slice();
    if (code === 0x07) {
      // Four bytes the reference calls a CRC-32 of the UID, then the UID.
      const block = pseudoRandom(16, this.seed + 0x107);
      block.set(this.uid, 4);
      return block;
    }
    if (loader && BOOTLOADER_BLANK.includes(code)) return new Uint8Array(size).fill(0xff);
    return pseudoRandom(size, this.seed + 0x100 + code);
  }

  /** Checks the host's transfer cap and the allowlist, then handles the request. */
  override async controlTransferIn(
    setup: USBControlTransferParameters,
    length: number,
  ): Promise<USBInTransferResult> {
    if (this.reachesDfu(setup)) {
      if (this.usbCap > 0 && length > this.usbCap) {
        throw new Error(`NetworkError: the host refused a control transfer of ${length} bytes`);
      }
      const why = this.forbiddenIn(setup.request, setup.value, length);
      if (why !== null) {
        this.forbidden.push(why);
        this.state = ERROR;
        return { status: 'stall' };
      }
    }
    return super.controlTransferIn(setup, length);
  }

  /** Checks the allowlist, then handles the request. */
  override async controlTransferOut(
    setup: USBControlTransferParameters,
    data?: BufferSource,
  ): Promise<USBOutTransferResult> {
    if (this.reachesDfu(setup)) {
      const bytes = !data
        ? new Uint8Array(0)
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
      if (setup.request === REQUEST_DNLOAD) this.commands.push(hexBytes(bytes));
      const why = this.forbiddenOut(setup.request, setup.value, bytes);
      if (why !== null) {
        this.forbidden.push(why);
        this.state = ERROR;
        return { status: 'stall', bytesWritten: 0 };
      }
    }
    return super.controlTransferOut(setup, data);
  }

  /** A DNLOAD command on the allowlist arrived. */
  protected onDnload(_blockNum: number, data: Uint8Array): void {
    if (this.state !== IDLE && this.state !== DNLOAD_IDLE) this.fail(`DNLOAD in state ${this.state}`);
    if (data[0] === 0xa2) {
      if (this.stallInfo.includes(data[1])) this.fail(`info block ${data[1]} is not answered`);
      this.selector = data[1];
    } else if (data[0] === 0x21) {
      this.pointer = new DataView(data.buffer, data.byteOffset).getUint32(1, true);
    } else if (data[1] === 0x01) {
      // The original firmware acts on 91 01 only below program mode; the bootloader takes it once.
      if (this.programMode && this.mode === 'bootloader') this.fail('91 01 twice');
      if (this.refuseProgramMode) this.fail('91 01 refused');
      this.modeByte = PROGRAM_MODE;
    } else {
      if (!this.programMode) this.fail('91 05 below program mode');
      this.pendingRestart = true;
    }
    this.state = DNLOAD_SYNC;
  }

  /** An UPLOAD on the allowlist arrived: an info block, the snapshot or SPI flash. */
  protected onUpload(blockNum: number, length: number): Uint8Array {
    if (blockNum === 0) {
      if (this.state !== IDLE) this.fail(`UPLOAD of block 0 in state ${this.state}`);
      const code = this.selector;
      this.selector = null;
      return code === null ? Uint8Array.of(0x00, 0x21, 0x41) : this.infoBlock(code);
    }
    if (this.state !== IDLE && this.state !== UPLOAD_IDLE) this.fail(`UPLOAD in state ${this.state}`);
    this.state = UPLOAD_IDLE;
    // Below program mode the block number is ignored: always the flash from its start.
    if (!this.programMode) return this.flash.slice(0, length);
    const address = this.pointer + (blockNum - 2) * BLOCK;
    const covers = (at: number | null) => at !== null && at >= address && at < address + length;
    if (covers(this.stallSpiAt)) this.fail(`SPI read at 0x${address.toString(16)} refused`);
    const limit =
      this.mode === 'bootloader' ? Math.min(BOOTLOADER_SPI_LIMIT, this.spi.length) : this.spi.length;
    if (address + length > limit) return this.stale.slice(0, length);
    this.stale = this.spi.slice(address, address + length);
    return covers(this.shortSpiAt) ? this.stale.slice(0, this.shortSpiAt! - address) : this.stale.slice();
  }

  /** GETSTATUS: a command runs after the first reply; `91 05` restarts instead of answering. */
  protected onGetStatus(): SimDfuStatus {
    if (this.state === DNLOAD_SYNC) {
      if (this.pendingRestart) {
        this.restart();
        throw new Error('NetworkError: the device was disconnected');
      }
      this.state = DNLOAD_IDLE;
      return { status: 0, pollTimeout: this.mode === 'bootloader' ? 1 : 0, state: DNBUSY };
    }
    return { status: this.state === ERROR ? ERR_STALLEDPKT : 0, pollTimeout: 0, state: this.state };
  }

  /** GETSTATE is not on the allowlist, so it never gets here. */
  protected onGetState(): number {
    return this.state;
  }

  /** CLRSTATUS leaves dfuERROR; in any other state the original firmware takes it as an error. */
  protected onClrStatus(): void {
    this.state = this.state === ERROR || this.mode === 'bootloader' ? IDLE : ERROR;
  }

  /** ABORT returns to dfuIDLE. */
  protected onAbort(): void {
    this.state = IDLE;
  }

  /** True for a class request to an interface of an open device: one the firmware sees. */
  private reachesDfu(setup: USBControlTransferParameters): boolean {
    return (
      this.opened && !this.disconnected && setup.requestType === 'class' && setup.recipient === 'interface'
    );
  }

  /** Why an IN request is outside the backup's allowlist, or null when it is on it. */
  private forbiddenIn(request: number, value: number, length: number): string | null {
    if (request === REQUEST_GETSTATUS) {
      return value === 0 && length === 6 ? null : `GETSTATUS value ${value}, ${length} bytes`;
    }
    if (request !== REQUEST_UPLOAD) return `IN request ${request}`;
    if (value === 1) return `UPLOAD block 1, ${length} bytes`;
    if (length <= BLOCK) return null;
    if (value === 2 && !this.programMode && length <= 65535) return null;
    return `UPLOAD block ${value}, ${length} bytes`;
  }

  /** Why an OUT request is outside the backup's allowlist, or null when it is on it. */
  private forbiddenOut(request: number, value: number, data: Uint8Array): string | null {
    if (request === REQUEST_CLRSTATUS || request === REQUEST_ABORT) {
      const name = request === REQUEST_ABORT ? 'ABORT' : 'CLRSTATUS';
      return value === 0 && data.length === 0 ? null : `${name} value ${value}, ${data.length} bytes`;
    }
    if (request !== REQUEST_DNLOAD) return `OUT request ${request}`;
    if (value !== 0) return `DNLOAD block ${value}, ${data.length} bytes`;
    if (data.length === 0) return 'zero-length DNLOAD';
    if (data.length === 2 && data[0] === 0xa2) return null;
    if (data.length === 5 && data[0] === 0x21) return null;
    if (data.length === 2 && data[0] === 0x91 && data[1] === 0x01) return null;
    if (data.length === 2 && data[0] === 0x91 && data[1] === 0x05 && this.mode === 'original') return null;
    return `DNLOAD block 0 [${hexBytes(data)}]`;
  }

  /** Stalls the request and leaves the device in dfuERROR. */
  private fail(why: string): never {
    this.state = ERROR;
    throw new SimStall(why);
  }

  /** The original firmware restarts: it drops off the bus and starts over. */
  private restart(): void {
    this.restarts++;
    this.pendingRestart = false;
    this.modeByte = 0;
    this.selector = null;
    this.pointer = 0;
    this.state = IDLE;
    this.disconnected = true;
  }
}
