// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Read-only backup of a Radioddity GD-77 or Baofeng DM-1801 that is running its
 * original firmware and in normal mode, over WebHID.
 *
 * This speaks the protocol of the manufacturer's programming software (CPS) as
 * dmrconfig does: Copyright (C) 2018 Serge Vakulenko KK6ABQ, BSD-3-Clause,
 * https://github.com/OpenRTX/dmrconfig (hid.c, hid-libusb.c, gd77.c, dm1801.c,
 * radio.c). From there: the `02 "PROGRA"` / `"M" 02` / `"A"` handshake and its 16-byte
 * identification, `CWB` to select bank 0 (addresses below 0x10000) or bank 1, `R`
 * reads of 32 bytes with a 16-bit address, `ENDR`, the frame checks, and the range
 * 0x80 up to 0x7C00 and from 0x8000 on, with 0x7C00-0x7FFF skipped.
 *
 * qdmr (Copyright (C) Hannes Matuschek DM3MAT, GPL-3.0; lib/radioddity_interface.cc,
 * lib/radioddity_radio.cc, lib/gd77_codeplug.cc) is the second source. Where the two
 * differ this follows qdmr: the bank is selected before the first read instead of
 * assumed, and `ENDR` is sent after reading (dmrconfig has that call commented out).
 * qdmr also names the banks: the lower one is the EEPROM, the upper one flash.
 *
 * From OpenGD77CPS (https://github.com/VR2VYE/OpenGD77CPS, which carries no licence)
 * only facts are used and no code: its table of the addresses the original CPS reads
 * ends at 0x1EEA0, `CWB` carries a 32-bit big-endian base address, the original CPS
 * waits 5 s for a reply, and the calibration editor reads 0x1000 bytes at CPS address
 * 0x7C00 after a 32-byte "pre-read" there, and takes two 0x70-byte blocks from the
 * start of that, each beginning A0 0F.
 *
 * The frames are the ones the bootloader uses, `[01 00 len_lo len_hi] + payload` out
 * and `[03 00 len_lo len_hi] + payload` in (hid-libusb.c: hid_send_recv), so the
 * framing helpers of src/flash/gd77.ts are reused.
 *
 * Only the handshake, bank selects, reads and `ENDR` are sent. The same protocol has
 * `W` and `ENDW` for writing; this file has no code that could build either.
 */
import {
  decodeGd77Frame,
  encodeGd77Frame,
  GD77_HID_FILTER,
  GD77_RESPONSE_TIMEOUT_MS,
  gd77Framing,
  type Gd77Framing,
  type Gd77Model,
} from '../flash/gd77.ts';
import { FlashError, type FlashContext } from '../flash/types.ts';
import type { BackupPart, BackupScope, PartKind, RadioBackup } from './types.ts';

/** Bytes per read request; the most the radio returns (hid.c, OpenGD77CPS). */
const READ_BYTES = 32;
/** Bytes of identification the handshake returns (hid.c: hid_identify). */
const IDENT_BYTES = 16;
/** Where the calibration editor of OpenGD77CPS looks, and how much it reads. */
export const GD77_CALIBRATION_ADDRESS = 0x7c00;
export const GD77_CALIBRATION_WINDOW_BYTES = 0x1000;
/** The part of that window OpenGD77CPS treats as calibration: two 0x70-byte blocks. */
export const GD77_CALIBRATION_DATA_BYTES = 0xe0;
/** First bytes of a calibration block; OpenGD77CPS finds only these two reliable. */
const CALIBRATION_MARKER = [0xa0, 0x0f];

const CMD_PRG = Uint8Array.of(0x02, 0x50, 0x52, 0x4f, 0x47, 0x52, 0x41);
const CMD_PRG2 = Uint8Array.of(0x4d, 0x02);
const CMD_ACK = Uint8Array.of(0x41);
const CMD_ENDR = Uint8Array.of(0x45, 0x4e, 0x44, 0x52);
const CMD_READ = 0x52;

/** One contiguous stretch of the programming-software address space. */
export interface Gd77Range {
  start: number;
  end: number;
  kind: PartKind;
}

/**
 * Where the second range ends. The GD-77 value is the end of the original CPS's
 * address table and covers the group lists, which dmrconfig's own layout puts up to
 * 0x1EE60 although its GD-77 download stops at 0x1E300 (qdmr reads to 0x1EB00). The
 * DM-1801 value is dmrconfig's (989 blocks of 128 bytes).
 */
const CODEPLUG_END: Record<Gd77Model, number> = { 'GD-77': 0x1eea0, 'DM-1801': 0x1ee80 };

/** What the radio calls itself in the handshake (radio.c: radio_tab and the image check). */
const IDENT_NAMES: Record<Gd77Model, string[]> = { 'GD-77': ['MD-760P', 'MD-760'], 'DM-1801': ['1801'] };

/** Options for readGd77Stock(). */
export interface Gd77StockOptions {
  /** Wait for each reply, in milliseconds; 5000 by default, as the original CPS. */
  responseTimeoutMs?: number;
  /** Overrides what the report descriptor says; for bench work. */
  framing?: Partial<Gd77Framing>;
  /** False leaves out the attempt to read the calibration window at 0x7C00. */
  calibration?: boolean;
}

/** The ranges dmrconfig reads, split where the EEPROM ends and the flash begins. */
export function gd77CodeplugRanges(model: Gd77Model): Gd77Range[] {
  return [
    { start: 0x00080, end: 0x07c00, kind: 'eeprom' },
    { start: 0x08000, end: 0x10000, kind: 'eeprom' },
    { start: 0x10000, end: CODEPLUG_END[model], kind: 'spi-flash' },
  ];
}

/** Hex dump for log and error messages. */
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

/** True when every byte of `bytes` is `value`. */
function allBytes(bytes: Uint8Array, value: number): boolean {
  return bytes.every((b) => b === value);
}

/** First 16 hex digits of the SHA-256 of `bytes`. */
async function fingerprint(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice()));
  return hex(digest.subarray(0, 8)).replaceAll(' ', '');
}

/** The printable ASCII at the start of `bytes`. */
function leadingText(bytes: Uint8Array): string {
  let end = 0;
  while (end < bytes.length && bytes[end] >= 0x20 && bytes[end] < 0x7f) end++;
  return String.fromCharCode(...bytes.subarray(0, end)).trim();
}

/**
 * The payload of one input report, checked as hid_send_recv() does: the frame must
 * start 03 00 and the high length byte must be 0. Returns null for anything else.
 */
function replyPayload(reportId: number, data: DataView): Uint8Array | null {
  const raw = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  // With numbered reports WebHID has already taken the first frame byte as the report ID.
  const head = reportId !== 0 ? [reportId, raw[0], raw[1], raw[2]] : [raw[0], raw[1], raw[2], raw[3]];
  if (head[0] !== 0x03 || head[1] !== 0x00 || head[3] !== 0x00) return null;
  const payload = decodeGd77Frame(reportId, data);
  return head[2] <= payload.length ? payload.subarray(0, head[2]) : null;
}

/** Request/response exchange with the radio's CPS personality over one HIDDevice. */
class StockLink {
  private readonly queue: (Uint8Array | null)[] = [];
  private waiter: ((reply: Uint8Array | null) => void) | null = null;
  /** Hands an input report to whoever waits for it, or queues it. */
  private readonly onReport = (event: HIDInputReportEvent): void => {
    const reply = replyPayload(event.reportId, event.data);
    if (this.waiter) this.waiter(reply);
    else this.queue.push(reply);
  };

  /** Starts listening for input reports. */
  constructor(
    private readonly dev: HIDDevice,
    private readonly framing: Gd77Framing,
    private readonly timeoutMs: number,
  ) {
    dev.addEventListener('inputreport', this.onReport);
  }

  /** Stops listening. */
  dispose(): void {
    this.dev.removeEventListener('inputreport', this.onReport);
  }

  /** Waits for the next input report; null when none comes in time. */
  private nextReply(): Promise<Uint8Array | null> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift() ?? null);
    return new Promise<Uint8Array | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve(null);
      }, this.timeoutMs);
      this.waiter = (reply) => {
        clearTimeout(timer);
        this.waiter = null;
        resolve(reply);
      };
    });
  }

  /**
   * hid_send_recv(): sends `payload` and returns the reply's payload, or null when
   * the radio does not answer in time or answers with a malformed frame.
   */
  async exchange(payload: Uint8Array): Promise<Uint8Array | null> {
    // One reply per command; anything left over belongs to nothing we can name.
    this.queue.length = 0;
    const { reportId, data } = encodeGd77Frame(this.framing, payload);
    try {
      await this.dev.sendReport(reportId, data);
    } catch (e) {
      throw new FlashError(`USB write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return this.nextReply();
  }

  /** Sends `payload` and says whether the radio answered "A". */
  async acknowledged(payload: Uint8Array): Promise<boolean> {
    const reply = await this.exchange(payload);
    return reply?.length === 1 && reply[0] === CMD_ACK[0];
  }
}

/** The error for a radio that does not take the programming-software handshake. */
function notNormalMode(detail: string): FlashError {
  return new FlashError(
    `The radio did not answer like one in normal mode (${detail}). Switch it off, then switch it on without holding the side keys, and try again.`,
  );
}

/** hid_identify(): enters programming mode and returns the 16 identification bytes. */
async function identify(link: StockLink): Promise<Uint8Array> {
  const first = await link.exchange(CMD_PRG);
  if (first === null) throw notNormalMode('no reply');
  if (first.length !== 1 || first[0] !== CMD_ACK[0]) throw notNormalMode(`it said [${hex(first)}]`);
  const ident = await link.exchange(CMD_PRG2);
  if (ident?.length !== IDENT_BYTES) {
    throw notNormalMode(ident ? `its identification is [${hex(ident)}]` : 'no identification');
  }
  if (!(await link.acknowledged(CMD_ACK))) throw notNormalMode('the identification was not confirmed');
  return ident;
}

/** Reads memory in 32-byte requests, selecting the bank as hid_read_block() does. */
class StockReader {
  /** The bank the radio has selected; -1 before the first select. */
  private bank = -1;
  private headerChecked = false;

  /** Reads over `link`; `log` gets the one-off remarks. */
  constructor(
    private readonly link: StockLink,
    private readonly log: (message: string) => void,
  ) {}

  /** `CWB 04` and the bank's base address, big endian; the radio answers "A". */
  private async select(bank: number): Promise<void> {
    const command = Uint8Array.of(0x43, 0x57, 0x42, 0x04, 0x00, bank, 0x00, 0x00);
    if (!(await this.link.acknowledged(command))) {
      throw new FlashError(`The radio did not switch to memory bank ${bank}.`);
    }
    this.bank = bank;
  }

  /** Reads [start, end); `onBytes` is told after every request. Throws FlashError on a bad reply. */
  async read(start: number, end: number, onBytes: (count: number) => void): Promise<Uint8Array> {
    const out = new Uint8Array(end - start);
    for (let address = start; address < end; address += READ_BYTES) {
      const bank = address >>> 16;
      if (bank !== this.bank) await this.select(bank);
      const count = Math.min(READ_BYTES, end - address);
      const request = Uint8Array.of(CMD_READ, (address >> 8) & 0xff, address & 0xff, count);
      const reply = await this.link.exchange(request);
      if (reply?.length !== 4 + count) {
        throw new FlashError(
          `Reading the radio failed at 0x${address.toString(16)}: ${reply ? `it answered [${hex(reply)}]` : 'no reply'}.`,
        );
      }
      if (!this.headerChecked) {
        // The references skip these 4 bytes without looking; worth knowing on a real radio.
        this.headerChecked = true;
        if (!request.every((b, i) => reply[i] === b)) {
          this.log(`Note: read replies start [${hex(reply.subarray(0, 4))}], not with the request.`);
        }
      }
      out.set(reply.subarray(4), address - start);
      onBytes(count);
    }
    return out;
  }
}

/**
 * Reads the codeplug of a GD-77 or DM-1801 that runs its original firmware, and the
 * calibration when the radio shows it at CPS address 0x7C00. Both scopes read the
 * same; the radio gives no more in normal mode. Opens `dev` if needed (and then closes
 * it again). Sends no write command. Throws FlashError when the radio does not take
 * the handshake (it is in flashing mode, or off) or a codeplug read fails; a
 * calibration window that cannot be read only adds a note.
 */
export async function readGd77Stock(
  dev: HIDDevice,
  model: Gd77Model,
  scope: BackupScope,
  ctx: FlashContext,
  options: Gd77StockOptions = {},
): Promise<RadioBackup> {
  const names = IDENT_NAMES[model];
  if (!names) throw new FlashError(`Unknown radio model "${String(model)}".`);
  const ranges = gd77CodeplugRanges(model);
  const wantCalibration = options.calibration !== false;
  const total =
    ranges.reduce((sum, r) => sum + r.end - r.start, 0) +
    (wantCalibration ? GD77_CALIBRATION_WINDOW_BYTES : 0);

  const framing = gd77Framing(dev, options.framing);
  if (dev.vendorId !== GD77_HID_FILTER.vendorId || dev.productId !== GD77_HID_FILTER.productId) {
    ctx.log('Warning: this is not the USB device a GD-77 or DM-1801 shows (15a2:0073).');
  }

  const parts: BackupPart[] = [];
  const notes: string[] = [];
  let firmware: string;
  let calibration: Uint8Array | null = null;
  let done = 0;
  /** Counts bytes towards the progress bar. */
  const onBytes = (count: number): void => {
    done += count;
    ctx.progress({ phase: 'read', done, total });
  };

  ctx.progress({ phase: 'connect', done: 0, total });
  const openedHere = !dev.opened;
  if (openedHere) await dev.open();
  const link = new StockLink(dev, framing, options.responseTimeoutMs ?? GD77_RESPONSE_TIMEOUT_MS);
  let inSession = false;
  try {
    // Neither reference sends ENDR after a handshake that failed, so the flag is set after it.
    const ident = await identify(link);
    inSession = true;
    // hid_identify() cuts the name at the first 0xFF; the 8 bytes after it start with a version.
    const name = leadingText(ident.subarray(0, 8));
    firmware = `${name} ${leadingText(ident.subarray(8))}`.trim();
    ctx.log(`The radio identifies itself as "${firmware}"`);
    if (!names.includes(name)) {
      const note = `The radio calls itself "${name}", which is not what a ${model} says (${names.join(' or ')}). It was read as a ${model} all the same.`;
      ctx.log(`Warning: ${note}`);
      notes.push(note);
    }

    const reader = new StockReader(link, (message) => ctx.log(message));
    for (const range of ranges) {
      const data = await reader.read(range.start, range.end, onBytes);
      parts.push({
        file: `codeplug-${range.start.toString(16).padStart(5, '0')}.bin`,
        kind: range.kind,
        address: range.start,
        data,
        complete: true,
        note: 'The address is the one programming software (CPS) uses for this data, not its place in the memory chip.',
      });
    }

    if (wantCalibration) {
      const start = GD77_CALIBRATION_ADDRESS;
      try {
        // OpenGD77CPS reads 32 bytes here first and ignores them; why is not known.
        await reader.read(start, start + READ_BYTES, () => {});
        calibration = await reader.read(start, start + GD77_CALIBRATION_WINDOW_BYTES, onBytes);
      } catch (e) {
        if (!(e instanceof FlashError)) throw e;
        ctx.log(`The calibration window did not read: ${e.message}`);
        notes.push('The calibration could not be read this way: the radio refused the request.');
      }
    }

    inSession = false;
    if (!(await link.acknowledged(CMD_ENDR))) {
      ctx.log('Warning: the radio did not confirm the end of the read.');
      notes.push(
        'The radio did not confirm the end of the read. If its screen still shows that it is being programmed, switch it off and on again.',
      );
    }
  } finally {
    // ENDR after a failed read too, as qdmr does, so that the radio leaves programming mode.
    if (inSession) await link.exchange(CMD_ENDR).catch(() => {});
    link.dispose();
    if (openedHere) await dev.close().catch(() => {});
  }

  let radioId: string | null = null;
  if (calibration) {
    const blocks = calibration.subarray(0, GD77_CALIBRATION_DATA_BYTES);
    if (allBytes(blocks, 0x00) || allBytes(blocks, 0xff)) {
      notes.push('The calibration could not be read this way: the radio returned only empty bytes there.');
    } else {
      const marked = CALIBRATION_MARKER.every((b, i) => blocks[i] === b);
      parts.push({
        file: 'calibration.bin',
        kind: 'info',
        address: GD77_CALIBRATION_ADDRESS,
        data: calibration,
        complete: true,
        note:
          `What the radio returns at programming-software address 0x7C00. Other tools take the first ${GD77_CALIBRATION_DATA_BYTES} bytes as the calibration; the bytes from 0x400 on are at addresses 0x8000 and up, which the codeplug parts hold too.` +
          (marked ? '' : ' It does not start with the bytes A0 0F that calibration data normally has.'),
      });
      if (marked) radioId = await fingerprint(blocks);
      else
        notes.push(
          'What the radio returned in place of the calibration does not look like calibration data.',
        );
    }
  }
  if (scope === 'all') {
    notes.push(
      'The whole 1 MB memory chip of this radio can only be read in a special start-up mode that this page does not use yet. This backup holds the codeplug, which is all the radio gives in normal mode.',
    );
  }
  ctx.progress({ phase: 'done', done: total, total });
  ctx.log(`Read ${parts.reduce((sum, p) => sum + p.data.length, 0)} bytes in ${parts.length} parts`);
  return { radioId, idKind: radioId === null ? null : 'fingerprint', firmware, parts, notes };
}
