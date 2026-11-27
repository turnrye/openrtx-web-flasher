// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Simulated Radioddity GD-77 / Baofeng DM-1801 running its original firmware and
 * in normal mode, as a WebHID device, for the read-only backup in
 * src/backup/gd77-stock.ts. It is the same USB device (15a2:0073) as the bootloader
 * that src/sim/gd77.ts simulates, with the programming-software personality.
 *
 * It is strict: it accepts only the conversation dmrconfig (Copyright (C) 2018 Serge
 * Vakulenko KK6ABQ, BSD-3-Clause; hid.c, hid-libusb.c) and qdmr have with the radio: the
 * `02 "PROGRA"` / `"M" 02` / `"A"` handshake step by step, `CWB` bank selects for
 * banks 0 and 1, `R` reads of 8, 16 or 32 bytes and `ENDR`. The byte arrays below are
 * written out here rather than shared with the reader, so a typo in the reader shows
 * up. Anything else is recorded and gets no answer; nothing is ever written.
 *
 * Not known from the references, and so invented here: that the read reply repeats
 * the 4 request bytes before the data (the references skip those 4 bytes unseen),
 * the identification bytes after the model name for these two models (the only
 * example in the references is an RD-5R's), what the 0x7C00 window returns, how a
 * refused read looks ("N", or silence), and what a radio in bootloader mode says to
 * the handshake ("N", as src/sim/gd77.ts does, or silence).
 */
import { hexSpaced, same } from '../bytes.ts';
import type { Gd77Model } from '../flash/gd77.ts';
import { byteReport, FakeHidDevice } from './hid.ts';
import { fillPattern } from './support.ts';

/** Bytes after the 4-byte frame header in a report. */
const TRANSFER_LENGTH = 38;
/** Frame header byte 0, host to radio and radio to host. */
const HOST_TO_RADIO = 0x01;
const RADIO_TO_HOST = 0x03;

const ACK = [0x41];
const NAK = [0x4e];
const PRG = [0x02, 0x50, 0x52, 0x4f, 0x47, 0x52, 0x41];
const PRG2 = [0x4d, 0x02];
const ENDR = [0x45, 0x4e, 0x44, 0x52];
const ENDW = [0x45, 0x4e, 0x44, 0x57];
const CWB = [0x43, 0x57, 0x42, 0x04];
const CMD_READ = 0x52;
const CMD_WRITE = 0x57;

/** What each model says in the handshake: its name padded with 0xFF, then 8 more bytes. */
const IDENT: Record<Gd77Model, number[]> = {
  // "MD-760P" and "V311"
  'GD-77': [0x4d, 0x44, 0x2d, 0x37, 0x36, 0x30, 0x50, 0xff, 0x56, 0x33, 0x31, 0x31, 0x00, 0x04, 0x80, 0x04],
  // "1801" and "V210"
  'DM-1801': [0x31, 0x38, 0x30, 0x31, 0xff, 0xff, 0xff, 0xff, 0x56, 0x32, 0x31, 0x30, 0x00, 0x04, 0x80, 0x04],
};

/** Start and end of the window dmrconfig skips, in programming-software addresses. */
export const SIM_GD77_WINDOW_START = 0x7c00;
export const SIM_GD77_WINDOW_END = 0x8000;

/** Options for the simulated radio. */
export interface SimGd77StockOptions {
  /** Which radio this is. */
  model: Gd77Model;
  /** Seed of the deterministic memory contents. */
  seed?: number;
  /** False makes the device use unnumbered reports, to exercise that mapping. */
  numberedReports?: boolean;
  /**
   * What reads of 0x7C00-0x7FFF return: the calibration (default), zeros, an "N"
   * instead of data, or no reply at all.
   */
  window?: 'calibration' | 'zeros' | 'error' | 'silent';
  /** Answer like a radio in flashing mode: "N" to everything, or nothing. */
  bootloader?: 'reply' | 'silent';
  /** The 16 identification bytes, when not the model's usual ones. */
  ident?: number[];
  /** Send no reply to the read of this programming-software address. */
  dropReadAt?: number;
  /** Send no reply to ENDR. */
  dropEndr?: boolean;
}

/** One read request the radio answered or was asked for. */
export interface SimGd77Read {
  /** Programming-software address: bank * 0x10000 + the 16-bit address in the request. */
  address: number;
  length: number;
}

/** Simulated GD-77 or DM-1801 with its original firmware, in normal mode. */
export class SimGd77Stock extends FakeHidDevice {
  /** Bank 0, addresses 0x0000-0xFFFF: the EEPROM. Tests may change it before reading. */
  readonly eeprom = new Uint8Array(0x10000);
  /** Bank 1, addresses 0x10000-0x1FFFF: part of the flash chip. */
  readonly flash = new Uint8Array(0x10000);
  /** What the 0x7C00-0x7FFF window shows when it shows the calibration. */
  readonly calibration = new Uint8Array(SIM_GD77_WINDOW_END - SIM_GD77_WINDOW_START).fill(0xff);
  /** Writes and unknown commands, oldest first. Must stay empty. */
  readonly forbidden: string[] = [];
  /** Protocol mistakes that could not have changed anything, oldest first. */
  readonly errors: string[] = [];
  /** Handshake steps and bank selects accepted, in order. */
  readonly steps: string[] = [];
  /** Every read request of an open session, in order. */
  readonly reads: SimGd77Read[] = [];
  /** Sessions closed with ENDR. */
  ended = 0;

  private readonly options: SimGd77StockOptions;
  private readonly numbered: boolean;
  private readonly reportSize: number;
  /** 0: idle; 1: PROGRA seen; 2: identification sent; 3: session open. */
  private stage = 0;
  private bank = 0;

  /** Creates a closed device full of deterministic data. */
  constructor(options: SimGd77StockOptions) {
    const numbered = options.numberedReports ?? true;
    const size = 3 + TRANSFER_LENGTH + (numbered ? 0 : 1);
    super({
      vendorId: 0x15a2,
      productId: 0x0073,
      productName: '',
      collections: [
        {
          usagePage: 0xff00,
          usage: 0x01,
          type: 1,
          children: [],
          outputReports: numbered ? [byteReport(1, size), byteReport(2, size)] : [byteReport(0, size)],
          inputReports: numbered ? [byteReport(3, size), byteReport(4, size)] : [byteReport(0, size)],
          featureReports: [],
        },
      ],
    });
    this.options = options;
    this.numbered = numbered;
    this.reportSize = size;
    const seed = options.seed ?? 1;
    fillPattern(this.eeprom, seed);
    fillPattern(this.flash, seed + 1000);
    // Two 0x70-byte blocks, each starting with the marker other tools look for.
    const blocks = new Uint8Array(0xe0);
    fillPattern(blocks, seed + 2000);
    blocks.set([0xa0, 0x0f, 0xc0, 0x12], 0);
    blocks.set([0xa0, 0x0f, 0xc0, 0x12], 0x70);
    this.calibration.set(blocks);
  }

  /** The bytes a read of [start, end) returns, in programming-software addresses. */
  memory(start: number, end: number): Uint8Array {
    const out = new Uint8Array(end - start);
    for (let i = 0; i < out.length; i++) {
      const address = start + i;
      if (address >= SIM_GD77_WINDOW_START && address < SIM_GD77_WINDOW_END) {
        out[i] = this.options.window === 'zeros' ? 0 : this.calibration[address - SIM_GD77_WINDOW_START];
      } else {
        out[i] = address < 0x10000 ? this.eeprom[address] : this.flash[address - 0x10000];
      }
    }
    return out;
  }

  /** Sends [0x03, 0x00, len_lo, len_hi, ...payload], zero-padded to the report size. */
  private respond(payload: ArrayLike<number>): void {
    const wire = new Uint8Array(this.reportSize + (this.numbered ? 1 : 0));
    wire[0] = RADIO_TO_HOST;
    wire[1] = 0x00;
    wire[2] = payload.length & 0xff;
    wire[3] = payload.length >> 8;
    wire.set(payload, 4);
    if (this.numbered) this.emitInputReport(wire[0], wire.subarray(1));
    else this.emitInputReport(0, wire);
  }

  /** Checks the frame header and padding, then hands the payload to the state machine. */
  protected onOutputReport(reportId: number, data: Uint8Array): void {
    if (this.numbered ? reportId !== HOST_TO_RADIO : reportId !== 0) {
      this.errors.push(`output report ID ${reportId}`);
      return;
    }
    if (data.length !== this.reportSize) {
      this.errors.push(`report of ${data.length} bytes, expected ${this.reportSize}`);
      return;
    }
    const wire = this.numbered ? Uint8Array.of(reportId, ...data) : data;
    const length = wire[2] | (wire[3] << 8);
    if (wire[0] !== HOST_TO_RADIO || wire[1] !== 0x00 || 4 + length > wire.length) {
      this.errors.push('bad frame header');
      return;
    }
    if (wire.subarray(4 + length).some((b) => b !== 0)) {
      this.errors.push('frame padding is not zero');
      return;
    }
    this.onFrame(wire.slice(4, 4 + length));
  }

  /** Names a frame that must never be sent to a radio being backed up, or null. */
  private forbiddenName(payload: Uint8Array): string | null {
    if (same(payload, PRG) || same(payload, PRG2) || same(payload, ACK) || same(payload, ENDR)) return null;
    if (payload.length === 4 && payload[0] === CMD_READ) return null;
    if (payload.length === 8 && same(payload.subarray(0, 5), [...CWB, 0x00]) && payload[5] <= 1) {
      return payload[6] === 0 && payload[7] === 0 ? null : `unknown command ${hexSpaced(payload)}`;
    }
    if (same(payload, ENDW)) return 'ENDW';
    if (payload[0] === CMD_WRITE && payload.length > 4) {
      return `write (W) of ${payload[3]} bytes at 0x${((payload[1] << 8) | payload[2]).toString(16)}`;
    }
    if (same(payload.subarray(0, 4), CWB)) return `bank select ${hexSpaced(payload)}`;
    return `unknown command ${hexSpaced(payload)}`;
  }

  /** The handshake, then bank selects, reads and ENDR. */
  private onFrame(payload: Uint8Array): void {
    const forbidden = this.forbiddenName(payload);
    if (forbidden !== null) {
      this.forbidden.push(forbidden);
      return;
    }
    if (this.options.bootloader) {
      if (this.options.bootloader === 'reply') this.respond(NAK);
      return;
    }

    if (this.stage < 3) {
      const expected = [PRG, PRG2, ACK][this.stage];
      if (!same(payload, expected)) {
        this.errors.push(`handshake step ${this.stage + 1}: got ${hexSpaced(payload)}`);
        return;
      }
      this.steps.push(['PROGRA', 'M', 'ACK'][this.stage]);
      this.stage++;
      if (this.stage === 3) this.bank = 0;
      return this.respond(this.stage === 2 ? (this.options.ident ?? IDENT[this.options.model]) : ACK);
    }

    if (same(payload, ENDR)) {
      this.stage = 0;
      this.ended++;
      if (!this.options.dropEndr) this.respond(ACK);
      return;
    }
    if (payload[0] === 0x43) {
      this.bank = payload[5];
      this.steps.push(`CWB${this.bank}`);
      return this.respond(ACK);
    }
    if (payload.length !== 4 || payload[0] !== CMD_READ) {
      this.errors.push(`in a session: got ${hexSpaced(payload)}`);
      return;
    }
    this.onRead(payload);
  }

  /** `R addr_hi addr_lo length`: the request repeated, then the data. */
  private onRead(request: Uint8Array): void {
    const length = request[3];
    const address = this.bank * 0x10000 + ((request[1] << 8) | request[2]);
    if (length !== 8 && length !== 16 && length !== 32) {
      this.errors.push(`read of ${length} bytes`);
      return;
    }
    if ((address & 0xffff) + length > 0x10000) {
      this.errors.push(`read across the end of bank ${this.bank}`);
      return;
    }
    this.reads.push({ address, length });
    if (address === this.options.dropReadAt) return;
    const inWindow = address < SIM_GD77_WINDOW_END && address + length > SIM_GD77_WINDOW_START;
    if (inWindow && this.options.window === 'silent') return;
    if (inWindow && this.options.window === 'error') return this.respond(NAK);
    this.respond([...request, ...this.memory(address, address + length)]);
  }
}
