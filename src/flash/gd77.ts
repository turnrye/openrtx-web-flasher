// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Firmware flasher for the Radioddity GD-77 and Baofeng DM-1801 over WebHID.
 *
 * This is a port of OpenRTX's scripts/gd-77_firmware_loader.py, the "GD-77 Firmware
 * uploader" by Roger Clark VK3KYY and the OpenGD77 contributors (Copyright Roger VK3KYY,
 * GPL-2.0-or-later as recorded in OpenRTX's REUSE.toml; used here under version 3 or
 * later). The handshake, the data framing and the per-kilobyte checksums follow that
 * script step for step.
 * radio_tool (Copyright (c) v0l, GPL-3.0-or-later; src/tyt_hid.cpp,
 * src/tyt_sgl_radio.cpp, src/tyt_fw_sgl.cpp) was used as a cross-reference for the
 * frame header and the SGL header layout.
 *
 * The radio must be in flashing mode, where it enumerates as the NXP MK22
 * vendor bootloader, USB 15a2:0073, a HID device. The firmware stays encrypted as it
 * is in the .sgl file; only the header is decoded, to get the length and the key.
 */
import { hexSpaced } from '../bytes.ts';
import { FlashError, messageOf, type FlashContext } from './types.ts';

/** Radios this flasher knows the handshake for. */
export type Gd77Model = 'GD-77' | 'DM-1801';

/** WebHID filter for the bootloader; pass it to navigator.hid.requestDevice(). */
export const GD77_HID_FILTER: HIDDeviceFilter = { vendorId: 0x15a2, productId: 0x0073 };

/** Largest payload the script accepts ("Firmware file too large"). */
export const GD77_MAX_PAYLOAD = 0x7b000;

/** How long the script waits for each response (dev.read(..., 5000)). */
export const GD77_RESPONSE_TIMEOUT_MS = 5000;

/** Bytes of firmware per data frame (DATA_TRANSFER_SIZE). */
const DATA_TRANSFER_SIZE = 0x20;
/** A checksum frame follows every this many bytes (BLOCK_LENGTH). */
const BLOCK_LENGTH = 0x400;
/** The script's TRANSFER_LENGTH: bytes after the 4-byte frame header in a full frame. */
const TRANSFER_LENGTH = 38;

/** First wire byte of a host-to-radio frame. */
const FRAME_HOST_TO_RADIO = 0x01;
/**
 * Fallback report size, not counting the report ID: 3 more header bytes plus
 * TRANSFER_LENGTH. The script reads 42 bytes from the endpoint and they compare equal
 * to a 38-byte expectation after dropping 4, so input reports are 1 + 41 bytes on the
 * wire; the output report is assumed to match.
 */
const FALLBACK_REPORT_BYTES = 3 + TRANSFER_LENGTH;

/** The radio's "OK" (responseOK in the script): the letter A. */
const RESPONSE_OK = Uint8Array.of(0x41);

/** Per-model constants from sendInitialCommands() and main() in the script. */
interface ModelInfo {
  /** Byte 11 of the .sgl a matching firmware carries (firmwareModelTag). */
  tag: number;
  /** First half of command2; the radio echoes it back. */
  id: string;
  /** command4, padded with 0xFF to 16 bytes. */
  group: string;
  /** command5, padded with 0xFF to 8 bytes. */
  model: string;
}

const MODELS: Record<Gd77Model, ModelInfo> = {
  'GD-77': { tag: 0x1b, id: 'DV01', group: 'SG-MD-760', model: 'MD-760' },
  'DM-1801': { tag: 0x4f, id: 'DV03', group: 'BF-DMR', model: '1801' },
};

/** Every firmwareModelTag in the script, to name a mismatched file. */
const TAG_NAMES: Record<number, string> = {
  0x1b: 'GD-77',
  0x70: 'GD-77S',
  0x4f: 'DM-1801',
  0x5c: 'RD-5R',
};

/** What the script reads out of an .sgl file. */
export interface ParsedSgl {
  /** The firmware, still encrypted, exactly as it is sent to the radio. */
  payload: Uint8Array;
  /** Four key bytes sent after the model ID in the handshake (encodeKey). */
  key: Uint8Array;
  /** Byte 11 of the file, which the script uses to tell the models apart. */
  modelTag: number;
  /** The model `modelTag` stands for, when this flasher supports it. */
  model: Gd77Model | undefined;
}

/** How protocol frames map onto HID reports for one device. */
export interface Gd77Framing {
  /**
   * True when the device uses numbered reports. Wire byte 0 of each frame then travels
   * as the report ID; otherwise it is the first data byte of report 0.
   */
  numbered: boolean;
  /** Report ID for frames to the radio; 0x01 unless the descriptor says otherwise. */
  outputReportId: number;
  /** Size of that report, not counting the report ID. Frames are zero-padded to it. */
  outputReportBytes: number;
}

/** Options for flashGd77(). */
export interface Gd77Options {
  /** Wait for each response, in milliseconds; the script uses 5000. */
  responseTimeoutMs?: number;
  /** Overrides what the report descriptor says; for bench work. */
  framing?: Partial<Gd77Framing>;
}

/** ASCII bytes of `text`, padded with `fill` to `length` when given. */
function ascii(text: string, length = text.length, fill = 0xff): Uint8Array {
  const out = new Uint8Array(length).fill(fill);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/**
 * Decodes an .sgl header as checkForSGLAndReturnEncryptedData() does: the length and
 * the key come from the XOR-obfuscated header, and the payload is the last `length`
 * bytes of the file.
 */
export function parseSgl(sgl: Uint8Array): ParsedSgl {
  const magic = ascii('SGL!');
  if (sgl.length < 16 || !magic.every((b, i) => sgl[i] === b)) {
    throw new FlashError('This is not an SGL firmware file: the "SGL!" header is missing.');
  }
  const modelTag = sgl[11];
  // Bytes 12..15, XORed with "SGL!": header offset (little endian) and a 2-byte XOR key.
  const offset = (sgl[12] ^ magic[0]) | ((sgl[13] ^ magic[1]) << 8);
  const xor = [sgl[14] ^ magic[2], sgl[15] ^ magic[3]];
  // The script decodes 512 bytes from offset + 6; only the first 0x61 are used.
  const start = offset + 6;
  const header = new Uint8Array(0x61);
  if (start + header.length > sgl.length) {
    throw new FlashError('The SGL firmware file is truncated.');
  }
  for (let i = 0; i < header.length; i++) header[i] = sgl[start + i] ^ xor[i % 2];

  const length = (header[0] | (header[1] << 8) | (header[2] << 16) | (header[3] << 24)) >>> 0;
  const key = header.slice(0x5d, 0x61);
  if (length === 0 || length > sgl.length - start - header.length) {
    throw new FlashError('The SGL firmware file is damaged: its length field does not fit the file.');
  }
  const name = TAG_NAMES[modelTag];
  return {
    payload: sgl.subarray(sgl.length - length),
    key,
    modelTag,
    model: name === 'GD-77' || name === 'DM-1801' ? name : undefined,
  };
}

/** Size in bytes of one report, not counting the report ID. */
function reportBytes(report: HIDReportInfo): number {
  let bits = 0;
  for (const item of report.items ?? []) bits += (item.reportSize ?? 0) * (item.reportCount ?? 0);
  return Math.ceil(bits / 8);
}

/** Lists the output reports in a collection tree. */
function outputReports(collections: readonly HIDCollectionInfo[]): HIDReportInfo[] {
  const out: HIDReportInfo[] = [];
  for (const c of collections) {
    out.push(...(c.outputReports ?? []), ...outputReports(c.children ?? []));
  }
  return out;
}

/**
 * Works out the framing from `dev.collections`. Report 0x01 is used when the
 * descriptor has it; a descriptor with only report 0 means unnumbered reports. With no
 * descriptor at all the fallback is numbered report 0x01 of 41 bytes.
 */
export function gd77Framing(dev: HIDDevice, overrides: Partial<Gd77Framing> = {}): Gd77Framing {
  const reports = outputReports(dev.collections ?? []);
  const report = reports.find((r) => (r.reportId ?? 0) === FRAME_HOST_TO_RADIO) ?? reports[0] ?? undefined;
  const id = report?.reportId ?? 0;
  const framing: Gd77Framing = report
    ? { numbered: id !== 0, outputReportId: id, outputReportBytes: reportBytes(report) }
    : { numbered: true, outputReportId: FRAME_HOST_TO_RADIO, outputReportBytes: FALLBACK_REPORT_BYTES };
  return { ...framing, ...overrides };
}

/**
 * Turns one protocol payload into a sendReport() call. THIS is the function to adjust
 * if a real radio disagrees with the simulator.
 *
 * The Python script writes these bytes to OUT endpoint 0x02 with libusb:
 *
 *     [0x01, 0x00, len_lo, len_hi, ...payload]
 *
 * On a HID device with numbered reports the first byte of such a transfer is the
 * report ID, and WebHID wants it as a separate argument. So the frame goes out as
 * sendReport(0x01, [0x00, len_lo, len_hi, ...payload]), zero-padded to the size the
 * report descriptor gives for the report (Windows requires full-size reports; the
 * vendor's Windows tool sends them that way, and the length field tells the radio how
 * much is payload). If the device turns out to use unnumbered reports, the whole frame
 * including the 0x01 is the data of report 0.
 */
export function encodeGd77Frame(
  framing: Gd77Framing,
  payload: Uint8Array,
): { reportId: number; data: Uint8Array<ArrayBuffer> } {
  const idBytes = framing.numbered ? 1 : 0;
  const wire = new Uint8Array(Math.max(4 + payload.length, idBytes + framing.outputReportBytes));
  wire[0] = framing.numbered ? framing.outputReportId : FRAME_HOST_TO_RADIO;
  wire[1] = 0x00;
  wire[2] = payload.length & 0xff;
  wire[3] = (payload.length >> 8) & 0xff;
  wire.set(payload, 4);
  return framing.numbered ? { reportId: wire[0], data: wire.slice(1) } : { reportId: 0, data: wire };
}

/**
 * Returns what the script calls `ret[4:]`: the input report without its 4-byte frame
 * header [0x03, 0x00, len_lo, len_hi]. WebHID has already removed the first of those
 * bytes when the device uses numbered reports (event.reportId is then non-zero).
 */
export function decodeGd77Frame(reportId: number, data: DataView): Uint8Array {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return bytes.slice(reportId !== 0 ? 3 : 4);
}

/** The script's response check: `expected` followed by nothing but zero padding. */
function responseMatches(response: Uint8Array, expected: Uint8Array): boolean {
  if (response.length < expected.length) return false;
  return response.every((b, i) => b === (i < expected.length ? expected[i] : 0));
}

/** createChecksumData(): "END", 0xFF, then the byte sum of [start, end), little endian. */
function checksumFrame(payload: Uint8Array, start: number, end: number): Uint8Array {
  let sum = 0;
  for (let i = start; i < end; i++) sum += payload[i];
  return Uint8Array.of(
    0x45,
    0x4e,
    0x44,
    0xff,
    sum & 0xff,
    (sum >> 8) & 0xff,
    (sum >> 16) & 0xff,
    (sum >>> 24) & 0xff,
  );
}

/** updateBlockAddressAndLength(): big-endian address and length at the frame start. */
function setAddressAndLength(frame: Uint8Array, address: number, length: number): void {
  frame[0] = (address >>> 24) & 0xff;
  frame[1] = (address >> 16) & 0xff;
  frame[2] = (address >> 8) & 0xff;
  frame[3] = address & 0xff;
  frame[4] = (length >> 8) & 0xff;
  frame[5] = length & 0xff;
}

/** Request/response exchange with the bootloader over one HIDDevice. */
class Gd77Link {
  private readonly queue: Uint8Array[] = [];
  private waiter: ((response: Uint8Array) => void) | null = null;
  /** Hands an input report to whoever waits for it, or queues it. */
  private readonly onReport = (event: HIDInputReportEvent): void => {
    const response = decodeGd77Frame(event.reportId, event.data);
    if (this.waiter) this.waiter(response);
    else this.queue.push(response);
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

  /** Waits for the next input report. */
  private nextResponse(what: string): Promise<Uint8Array> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(
          new FlashError(
            `No response from the radio while ${what}. Is it in firmware update mode and still connected?`,
          ),
        );
      }, this.timeoutMs);
      this.waiter = (response) => {
        clearTimeout(timer);
        this.waiter = null;
        resolve(response);
      };
    });
  }

  /** sendAndCheckResponse(): sends `payload` and requires `expected` back. */
  async exchange(payload: Uint8Array, expected: Uint8Array, what: string): Promise<void> {
    // One response per command; anything left over belongs to nothing we can name.
    this.queue.length = 0;
    const { reportId, data } = encodeGd77Frame(this.framing, payload);
    try {
      await this.dev.sendReport(reportId, data);
    } catch (e) {
      throw new FlashError(`USB write failed while ${what}: ${messageOf(e)}`);
    }
    const response = await this.nextResponse(what);
    if (!responseMatches(response, expected)) {
      throw new FlashError(
        `Unexpected response from the radio while ${what}: got [${hexSpaced(response)}], expected [${hexSpaced(expected)}].`,
      );
    }
  }
}

/** sendInitialCommands(): identifies us as the updater and erases the firmware area. */
async function sendInitialCommands(
  link: Gd77Link,
  info: ModelInfo,
  key: Uint8Array,
  total: number,
  ctx: FlashContext,
): Promise<void> {
  const id = ascii(info.id);
  const keyCommand = new Uint8Array(8);
  keyCommand.set(id, 0);
  keyCommand.set(key, 4);
  // The last byte of PROGRAM is 0x0F in the script, not 0xFF; kept as it is.
  const program = Uint8Array.of(0x50, 0x52, 0x4f, 0x47, 0x52, 0x41, 0x4d, 0x0f);
  const steps: [what: string, command: Uint8Array, expected: Uint8Array, erase?: boolean][] = [
    ['sending the download command', ascii('DOWNLOAD'), ascii('#UPDATE?')],
    ['sending the ACK', RESPONSE_OK, RESPONSE_OK],
    ['sending the encryption key', keyCommand, id],
    ['sending the F-PROG command', ascii('F-PROG', 8), RESPONSE_OK],
    ['sending the radio model number', ascii(info.group, 16), RESPONSE_OK],
    ['sending the radio model number 2', ascii(info.model, 8), RESPONSE_OK],
    ['sending the version', ascii('V1.00.01'), RESPONSE_OK],
    ['sending the erase command', ascii('F-ERASE', 8), RESPONSE_OK, true],
    ['sending the post-erase command', RESPONSE_OK, RESPONSE_OK],
    ['sending the program command', program, RESPONSE_OK],
  ];
  for (const [what, command, expected, erase] of steps) {
    ctx.log(what.charAt(0).toUpperCase() + what.slice(1));
    if (erase) ctx.progress({ phase: 'erase', done: 0, total });
    await link.exchange(command, expected, what);
    if (erase) ctx.progress({ phase: 'erase', done: total, total });
  }
}

/** sendFileData(): 32-byte data frames, a checksum frame after each kilobyte and at the end. */
async function sendFileData(link: Gd77Link, payload: Uint8Array, ctx: FlashContext): Promise<void> {
  const total = payload.length;
  // One buffer for every data frame, as in the script: a short last frame is still 38
  // bytes long and carries the previous frame's bytes after its own.
  const frame = new Uint8Array(6 + DATA_TRANSFER_SIZE);
  let checksumStart = 0;
  let address = 0;

  ctx.progress({ phase: 'write', done: 0, total });
  while (address < total) {
    if (address % BLOCK_LENGTH === 0) checksumStart = address;
    const what = `writing at 0x${address.toString(16)}`;

    if (address + DATA_TRANSFER_SIZE < total) {
      setAddressAndLength(frame, address, DATA_TRANSFER_SIZE);
      frame.set(payload.subarray(address, address + DATA_TRANSFER_SIZE), 6);
      await link.exchange(frame, RESPONSE_OK, what);
      address += DATA_TRANSFER_SIZE;
      if (address % BLOCK_LENGTH === 0) {
        await link.exchange(
          checksumFrame(payload, checksumStart, address),
          RESPONSE_OK,
          `${what} (checksum)`,
        );
      }
    } else {
      const size = total - address;
      setAddressAndLength(frame, address, size);
      frame.set(payload.subarray(address, address + size), 6);
      await link.exchange(frame, RESPONSE_OK, what);
      address += size;
      await link.exchange(checksumFrame(payload, checksumStart, address), RESPONSE_OK, `${what} (checksum)`);
    }
    ctx.progress({ phase: 'write', done: address, total });
  }
}

/**
 * Flashes an OpenRTX .sgl onto a GD-77 or DM-1801 that is in flashing mode.
 * Opens `dev` if needed (and then closes it again). Throws FlashError when the file is
 * for another radio or the radio answers anything but what the script expects.
 */
export async function flashGd77(
  dev: HIDDevice,
  sgl: Uint8Array,
  model: Gd77Model,
  ctx: FlashContext,
  options: Gd77Options = {},
): Promise<void> {
  const info = MODELS[model];
  if (!info) throw new FlashError(`Unknown radio model "${String(model)}".`);

  const { payload, key, modelTag } = parseSgl(sgl);
  if (modelTag !== info.tag) {
    const other = TAG_NAMES[modelTag];
    throw new FlashError(
      `The firmware doesn't match the transceiver model: this file is for ${other ? `the ${other}` : 'another radio'}, not the ${model}.`,
    );
  }
  if (payload.length > GD77_MAX_PAYLOAD) throw new FlashError('The firmware file is too large.');
  const total = payload.length;

  const framing = gd77Framing(dev, options.framing);
  ctx.log(
    `HID framing: ${framing.numbered ? `report 0x${framing.outputReportId.toString(16).padStart(2, '0')}` : 'unnumbered report'}, ${framing.outputReportBytes} bytes`,
  );
  if (framing.outputReportBytes < (framing.numbered ? 3 : 4) + TRANSFER_LENGTH) {
    ctx.log('Warning: the HID output report is smaller than a data frame; frames go out unpadded.');
  }
  if (dev.vendorId !== GD77_HID_FILTER.vendorId || dev.productId !== GD77_HID_FILTER.productId) {
    ctx.log(
      'Warning: this is not the USB device a GD-77 or DM-1801 shows in firmware update mode (15a2:0073).',
    );
  }

  ctx.progress({ phase: 'connect', done: 0, total });
  const openedHere = !dev.opened;
  if (openedHere) await dev.open();
  const link = new Gd77Link(dev, framing, options.responseTimeoutMs ?? GD77_RESPONSE_TIMEOUT_MS);
  try {
    ctx.log(`Now flashing your ${model}: ${total} bytes`);
    await sendInitialCommands(link, info, key, total, ctx);
    await sendFileData(link, payload, ctx);
    ctx.progress({ phase: 'done', done: total, total });
    ctx.log(`Firmware update complete. Please reboot the ${model}.`);
  } finally {
    link.dispose();
    if (openedHere) await dev.close().catch(() => {});
  }
}
