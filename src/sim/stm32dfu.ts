// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Simulated STM32 ROM bootloader in USB DFU mode (DfuSe), with a flash image.
 *
 * It follows the DFU 1.1 state machine and ST's AN3156 and is strict on purpose: a
 * request in the wrong state, a poll before bwPollTimeout has passed, a write to bytes
 * that were not erased or an address outside the flash puts it in dfuERROR, and the
 * mistake is listed in `violations`. Pass `sim.sleep` as the FlashContext sleep so the
 * simulator sees how long the host waited.
 */
import { SimStall, SimUsbDevice, type SimDfuStatus } from './usb.ts';

const IDLE = 2;
const DNLOAD_SYNC = 3;
const DNBUSY = 4;
const DNLOAD_IDLE = 5;
const MANIFEST_SYNC = 6;
const MANIFEST = 7;
const UPLOAD_IDLE = 9;
const ERROR = 10;

/** DFU status codes the simulator reports. */
export const SimDfuError = {
  errTARGET: 0x01,
  errADDRESS: 0x08,
  errVENDOR: 0x0b,
  errSTALLEDPKT: 0x0f,
} as const;

/** A command or write that the device accepts on the wire but then fails. */
export class SimFault extends Error {
  /** Fault with the DFU status code the device will report. */
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** One flash sector of the simulated chip. */
export interface SimSector {
  start: number;
  size: number;
}

/** What the ROM of each supported chip looks like on USB. */
const CHIPS = {
  f405: {
    sectorSizes: [0x4000, 0x4000, 0x4000, 0x4000, 0x10000, ...Array<number>(7).fill(0x20000)],
    transferSize: 2048,
    alternateNames: [
      '@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg',
      '@Option Bytes  /0x1FFFC000/01*016 e',
      '@OTP Memory /0x1FFF7800/01*512 e,01*016 e',
      '@Device Feature/0xFFFF0000/01*004 e',
    ],
  },
  h743: {
    sectorSizes: Array<number>(16).fill(0x20000),
    transferSize: 1024,
    alternateNames: ['@Internal Flash   /0x08000000/16*128Kg', '@Option Bytes   /0x5200201C/01*128 e'],
  },
};

/** Options for the simulated ROM. */
export interface SimStm32Options {
  /** Chip whose flash layout to simulate; default 'f405'. */
  chip?: 'f405' | 'h743';
  vendorId?: number;
  productId?: number;
  productName?: string;
  manufacturerName?: string;
  /** wTransferSize; default is the chip's (2048 on F405, 1024 on H743). */
  transferSize?: number;
  /** Alternate setting names; default is the chip's ROM list. */
  alternateNames?: (string | null)[];
  /** When false, WebUSB shows no interface names and the host must read the strings. */
  exposeInterfaceNames?: boolean;
  /** When false, GET_DESCRIPTOR stalls. */
  serveDescriptors?: boolean;
  /** When true, UPLOAD fails as on a read-protected chip. */
  readProtected?: boolean;
  /** When false, polling before bwPollTimeout has passed is tolerated. Default true. */
  strictPoll?: boolean;
  /** Flip a bit of the byte written at this address, so read-back verification fails. */
  corruptAt?: number;
}

/** Simulated STM32F405 / STM32H743 system bootloader on USB. */
export class SimStm32Dfu extends SimUsbDevice {
  /** Flash contents from `flashBase`, 0xFF when erased. */
  readonly flash: Uint8Array;
  readonly flashBase = 0x08000000;
  readonly sectors: SimSector[] = [];
  readonly transferSize: number;
  /** Protocol mistakes the host made, in order; empty after a clean session. */
  readonly violations: string[] = [];
  /** Address the firmware was started at by a DfuSe leave, or null. */
  startedAt: number | null = null;
  /** Milliseconds the host has slept, counted by `sleep`. */
  clock = 0;
  /** FlashContext.sleep replacement that advances the simulator's clock. */
  readonly sleep = (ms: number): Promise<void> => {
    this.clock += ms;
    return Promise.resolve();
  };

  protected state: number = IDLE;
  protected pointer = 0x08000000;
  private status = 0;
  private pending: (() => number) | null = null;
  private outcome = 0;
  private busyUntil = 0;
  private readonly readProtected: boolean;
  private readonly strictPoll: boolean;
  private readonly corruptAt: number | null;

  /** Builds a blank (all 0xFF) chip in dfuIDLE. */
  constructor(options: SimStm32Options = {}) {
    const chip = CHIPS[options.chip ?? 'f405'];
    const transferSize = options.transferSize ?? chip.transferSize;
    super({
      vendorId: options.vendorId ?? 0x0483,
      productId: options.productId ?? 0xdf11,
      productName: options.productName ?? 'STM32  BOOTLOADER',
      manufacturerName: options.manufacturerName ?? 'STMicroelectronics',
      alternateNames: options.alternateNames ?? chip.alternateNames,
      transferSize,
      exposeInterfaceNames: options.exposeInterfaceNames,
      serveDescriptors: options.serveDescriptors,
    });
    this.transferSize = transferSize;
    this.readProtected = options.readProtected ?? false;
    this.strictPoll = options.strictPoll ?? true;
    this.corruptAt = options.corruptAt ?? null;
    let start = this.flashBase;
    for (const size of chip.sectorSizes) {
      this.sectors.push({ start, size });
      start += size;
    }
    this.flash = new Uint8Array(start - this.flashBase).fill(0xff);
  }

  /** Copy of `length` flash bytes at an absolute address. */
  read(address: number, length: number): Uint8Array {
    return this.flash.slice(address - this.flashBase, address - this.flashBase + length);
  }

  /** Pre-loads the flash, e.g. to simulate firmware that is already installed. */
  load(address: number, data: Uint8Array): void {
    this.flash.set(data, address - this.flashBase);
  }

  /** Records a protocol mistake, enters dfuERROR and stalls the request. */
  protected violate(why: string): never {
    this.violations.push(why);
    this.state = ERROR;
    this.status = SimDfuError.errSTALLEDPKT;
    this.pending = null;
    throw new SimStall(why);
  }

  /** True when the whole range lies inside the flash. */
  protected inFlash(address: number, length: number): boolean {
    return address >= this.flashBase && address + length <= this.flashBase + this.flash.length;
  }

  /** Flash access needs the "@Internal Flash" alternate setting when settings are named. */
  private requireInternalFlash(): void {
    const name = this.alternateName;
    if (name !== null && !name.startsWith('@Internal Flash')) {
      throw new SimFault(SimDfuError.errTARGET, `flash access on alternate setting "${name}"`);
    }
  }

  /** Runs a wBlockNum 0 command; returns its bwPollTimeout. Subclasses add commands. */
  protected runCommand(data: Uint8Array): number {
    const address = data.length === 5 ? new DataView(data.buffer, data.byteOffset).getUint32(1, true) : null;
    if (data[0] === 0x21 && address !== null) {
      if (!this.inFlash(address, 1)) {
        throw new SimFault(SimDfuError.errTARGET, `set address outside the flash: 0x${address.toString(16)}`);
      }
      this.pointer = address;
      return 0;
    }
    if (data[0] === 0x41 && address !== null) return this.eraseSector(address);
    if (data[0] === 0x41 && data.length === 1) {
      this.requireInternalFlash();
      this.flash.fill(0xff);
      return 10000;
    }
    throw new SimFault(
      SimDfuError.errTARGET,
      `unknown command 0x${data[0].toString(16)} of ${data.length} bytes`,
    );
  }

  /** Erases the sector containing `address`; returns its bwPollTimeout. */
  protected eraseSector(address: number): number {
    this.requireInternalFlash();
    const sector = this.sectors.find((s) => address >= s.start && address < s.start + s.size);
    if (!sector)
      throw new SimFault(SimDfuError.errTARGET, `erase outside the flash: 0x${address.toString(16)}`);
    this.flash.fill(0xff, sector.start - this.flashBase, sector.start - this.flashBase + sector.size);
    return sector.size >> 7; // 128 ms for 16K, about 1 s for 128K
  }

  /** True when a flash byte holding `old` may be programmed with `value`. */
  protected canProgram(old: number, _value: number): boolean {
    return old === 0xff;
  }

  /** Programs `data` at `address`; returns its bwPollTimeout. */
  protected program(address: number, data: Uint8Array): number {
    this.requireInternalFlash();
    if (!this.inFlash(address, data.length)) {
      throw new SimFault(SimDfuError.errADDRESS, `write outside the flash: 0x${address.toString(16)}`);
    }
    const offset = address - this.flashBase;
    for (let i = 0; i < data.length; i++) {
      if (!this.canProgram(this.flash[offset + i], data[i])) {
        throw new SimFault(
          SimDfuError.errVENDOR,
          `write to unerased flash at 0x${(address + i).toString(16)}`,
        );
      }
    }
    this.flash.set(data, offset);
    const corrupt = this.corruptAt;
    if (corrupt !== null && corrupt >= address && corrupt < address + data.length) {
      this.flash[corrupt - this.flashBase] ^= 0x01;
    }
    return 2;
  }

  /** Handles a zero-length DNLOAD: the DfuSe "leave" request. */
  protected onLeaveRequest(): void {
    if (this.state !== DNLOAD_IDLE) this.violate('zero-length DNLOAD outside dfuDNLOAD-IDLE');
    this.state = MANIFEST_SYNC;
  }

  /** DNLOAD: queues a command (block 0), a write (block 2+) or the leave (no data). */
  protected onDnload(blockNum: number, data: Uint8Array): void {
    if (this.state !== IDLE && this.state !== DNLOAD_IDLE) this.violate(`DNLOAD in state ${this.state}`);
    if (data.length > this.transferSize) this.violate(`DNLOAD of ${data.length} bytes exceeds wTransferSize`);
    if (data.length === 0) return this.onLeaveRequest();
    if (blockNum === 1) this.violate('DNLOAD with wBlockNum 1');
    if (blockNum === 0) {
      const command = data.slice();
      this.pending = () => this.runCommand(command);
    } else {
      // The address is fixed when the block arrives, as in the ROM.
      const address = this.pointer + (blockNum - 2) * this.transferSize;
      const block = data.slice();
      this.pending = () => this.program(address, block);
    }
    this.state = DNLOAD_SYNC;
  }

  /** UPLOAD: reads flash at the address pointer plus (block - 2) * wTransferSize. */
  protected onUpload(blockNum: number, length: number): Uint8Array {
    if (this.state !== IDLE && this.state !== UPLOAD_IDLE) this.violate(`UPLOAD in state ${this.state}`);
    if (length > this.transferSize) this.violate(`UPLOAD of ${length} bytes exceeds wTransferSize`);
    if (blockNum === 1) this.violate('UPLOAD with wBlockNum 1');
    if (blockNum === 0) return Uint8Array.of(0x00, 0x21, 0x41); // "get commands"
    if (this.readProtected) {
      this.violations.push('UPLOAD from a read-protected chip');
      this.state = ERROR;
      this.status = SimDfuError.errVENDOR;
      throw new SimStall('read protected');
    }
    const address = this.pointer + (blockNum - 2) * this.transferSize;
    if (!this.inFlash(address, length)) this.violate(`UPLOAD outside the flash: 0x${address.toString(16)}`);
    this.state = length < this.transferSize ? IDLE : UPLOAD_IDLE; // a short frame ends the upload
    return this.read(address, length);
  }

  /** GETSTATUS: runs the queued operation, then reports its result on the next poll. */
  protected onGetStatus(): SimDfuStatus {
    if (this.state === DNLOAD_SYNC && this.pending) {
      // The ROM runs the command or write now and reports the result on the next poll.
      let pollTimeout = 0;
      this.outcome = 0;
      try {
        pollTimeout = this.pending();
      } catch (e) {
        if (!(e instanceof SimFault)) throw e;
        this.violations.push(e.message);
        this.outcome = e.status;
      }
      this.pending = null;
      this.busyUntil = this.clock + pollTimeout;
      this.state = DNBUSY;
      return { status: 0, pollTimeout, state: DNBUSY };
    }
    if (this.state === DNBUSY) {
      if (this.strictPoll && this.clock < this.busyUntil) {
        this.violate(`GETSTATUS ${this.busyUntil - this.clock} ms before bwPollTimeout passed`);
      }
      this.status = this.outcome;
      this.state = this.outcome === 0 ? DNLOAD_IDLE : ERROR;
    } else if (this.state === MANIFEST_SYNC) {
      // Leave: the MCU jumps to the address pointer and drops off the bus.
      this.startedAt = this.pointer;
      this.disconnected = true;
      return { status: 0, pollTimeout: 0, state: MANIFEST };
    }
    return { status: this.status, pollTimeout: 0, state: this.state };
  }

  /** GETSTATE: the state byte, no side effects. */
  protected onGetState(): number {
    return this.state;
  }

  /** CLRSTATUS: dfuERROR to dfuIDLE; a mistake in any other state. */
  protected onClrStatus(): void {
    if (this.state !== ERROR) this.violate(`CLRSTATUS in state ${this.state}`);
    this.state = IDLE;
    this.status = 0;
  }

  /** ABORT: back to dfuIDLE, keeping the address pointer. */
  protected onAbort(): void {
    if (this.state === DNBUSY) this.violate('ABORT while dfuDNBUSY');
    if (this.state === ERROR) return; // only CLRSTATUS leaves dfuERROR
    this.pending = null;
    this.state = IDLE;
  }
}
