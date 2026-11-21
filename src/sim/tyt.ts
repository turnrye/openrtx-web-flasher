// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Simulated TYT vendor bootloader (MD-380, MD-UV380/390, MD-9600, DM-1701).
 *
 * The bootloader speaks DfuSe with 1024-byte blocks plus vendor commands starting with
 * 0x91. This simulator accepts only what radio_tool sends: flash access needs the
 * `91 31` "firmware upgrade" command first, a sector must be erased in this session
 * before it is written, the bootloader's own sectors are off limits, and there is no
 * read-back and no leave. Everything the host downloads is recorded in `ops` so tests
 * can compare the order with radio_tool's.
 */
import { SimDfuError, SimFault, SimStm32Dfu } from './stm32dfu.ts';

/** First address the bootloader lets the host change; below it is the bootloader. */
const APPLICATION_START = 0x0800c000;
const TRANSFER_SIZE = 1024;

/** One download the host sent, decoded. */
export type TytOp =
  | { op: 'command'; code: number }
  | { op: 'erase'; address: number }
  | { op: 'setAddress'; address: number }
  | { op: 'write'; block: number; address: number; length: number }
  | { op: 'other'; block: number; length: number };

/** Options for the simulated radio. */
export interface SimTytOptions {
  productName?: string;
  /** Layout strings to report instead of the bootloader's, e.g. the original firmware's. */
  alternateNames?: (string | null)[];
}

/** What the TYT bootloader reports (RadioFoundry hardware-md9600.md 15.1, measured). */
export const TYT_BOOTLOADER_NAMES = [
  '@Internal Flash   /0x0800C000/01*016Kg,01*064Kg,07*128Kg',
  '@SPI Flash Memory /0x00000000/16*064Kg',
];

/** What the original firmware reports when the radio is in normal mode. */
export const TYT_ORIGINAL_NAMES = [
  '@Internal Flash   /0x08000000/03*016Kg',
  '@SPI Flash Memory /0x00000000/16*064Kg',
];

/** Simulated TYT radio in bootloader ("USB mode"). */
export class SimTytRadio extends SimStm32Dfu {
  /** Every DNLOAD the host sent, decoded, in order. */
  readonly ops: TytOp[] = [];
  /** True once the host has sent the `91 31` firmware upgrade command. */
  upgradeMode = false;
  private readonly erased = new Set<number>();

  /** Builds a radio with blank application flash, waiting for `91 31`. */
  constructor(options: SimTytOptions = {}) {
    super({
      chip: 'f405',
      productName: options.productName ?? 'Digital Radio in USB mode',
      manufacturerName: 'AnyRoad Technology',
      transferSize: TRANSFER_SIZE,
      alternateNames: options.alternateNames ?? TYT_BOOTLOADER_NAMES,
      // radio_tool never waits bwPollTimeout, and the radio copes.
      strictPoll: false,
    });
  }

  /** Fails flash access that the bootloader would refuse. */
  private guard(what: string, address: number): void {
    if (!this.upgradeMode) {
      throw new SimFault(SimDfuError.errVENDOR, `${what} before the 91 31 firmware upgrade command`);
    }
    if (address < APPLICATION_START) {
      throw new SimFault(SimDfuError.errTARGET, `${what} inside the bootloader at 0x${address.toString(16)}`);
    }
  }

  /** Adds the `91 31` vendor command to the DfuSe ones. */
  protected override runCommand(data: Uint8Array): number {
    if (data[0] !== 0x91) return super.runCommand(data);
    if (data.length !== 2 || data[1] !== 0x31) {
      throw new SimFault(
        SimDfuError.errTARGET,
        `vendor command 91 ${data[1]?.toString(16)} is not simulated`,
      );
    }
    this.upgradeMode = true;
    return 0;
  }

  /** Erases a sector and remembers it was erased in this session. */
  protected override eraseSector(address: number): number {
    this.guard('erase', address);
    const poll = super.eraseSector(address);
    const sector = this.sectors.find((s) => address >= s.start && address < s.start + s.size);
    if (sector) this.erased.add(sector.start);
    return poll;
  }

  /** NOR flash: bits only go from 1 to 0, so writing the same bytes twice is fine. */
  protected override canProgram(old: number, value: number): boolean {
    return (old & value) === value;
  }

  /** Writes only to application sectors erased in this session. */
  protected override program(address: number, data: Uint8Array): number {
    this.guard('write', address);
    for (const s of this.sectors) {
      const touched = s.start < address + data.length && s.start + s.size > address;
      if (touched && !this.erased.has(s.start)) {
        throw new SimFault(
          SimDfuError.errVENDOR,
          `write to sector 0x${s.start.toString(16)} before erasing it`,
        );
      }
    }
    return super.program(address, data);
  }

  /** The TYT bootloader has no leave; the user power-cycles the radio. */
  protected override onLeaveRequest(): void {
    this.violate('zero-length DNLOAD: the TYT bootloader has no leave');
  }

  /** Records the download in `ops`, then handles it. */
  protected override onDnload(blockNum: number, data: Uint8Array): void {
    this.ops.push(this.decode(blockNum, data));
    super.onDnload(blockNum, data);
  }

  /** The TYT bootloader has no flash read-back. */
  protected override onUpload(): Uint8Array {
    return this.violate('UPLOAD: the TYT bootloader cannot read the flash back');
  }

  /** Decodes one DNLOAD for the trace. */
  private decode(blockNum: number, data: Uint8Array): TytOp {
    if (blockNum >= 2) {
      const address = this.pointer + (blockNum - 2) * TRANSFER_SIZE;
      return { op: 'write', block: blockNum, address, length: data.length };
    }
    const address = data.length === 5 ? new DataView(data.buffer, data.byteOffset).getUint32(1, true) : null;
    if (blockNum === 0 && data[0] === 0x91 && data.length === 2) return { op: 'command', code: data[1] };
    if (blockNum === 0 && data[0] === 0x41 && address !== null) return { op: 'erase', address };
    if (blockNum === 0 && data[0] === 0x21 && address !== null) return { op: 'setAddress', address };
    return { op: 'other', block: blockNum, length: data.length };
  }
}
