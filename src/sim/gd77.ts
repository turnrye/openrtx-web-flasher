// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Simulated GD-77 / DM-1801 in flashing mode (NXP MK22 vendor bootloader, USB
 * 15a2:0073), as a WebHID device.
 *
 * It is strict: it accepts exactly the conversation OpenRTX's
 * scripts/gd-77_firmware_loader.py (Copyright Roger VK3KYY, GPL-2.0-or-later, used here
 * under version 3 or later) has with the radio, in order
 * and byte for byte, and after the first mistake it stops cooperating. The byte arrays
 * below are copied from that script rather than shared with the flasher, so a typo in
 * the flasher shows up here. What the real bootloader does on an error is not known;
 * the two behaviours offered (an "N" reply, or silence) are inventions.
 *
 * buildSgl() makes .sgl fixtures the way scripts/bin2sgl.py does (a derivation of
 * OpenGD77, Copyright (C) 2019 Kai Ludwig DG4KLU, BSD-3-Clause), with a stand-in
 * cipher table so that no fixture is ever valid firmware.
 */
import { same } from '../bytes.ts';
import type { Gd77Model } from '../flash/gd77.ts';
import { byteReport, FakeHidDevice } from './hid.ts';

/** Bytes after the 4-byte frame header in a response (TRANSFER_LENGTH in the script). */
const TRANSFER_LENGTH = 38;
/** Frame header byte 0, host to radio and radio to host. */
const HOST_TO_RADIO = 0x01;
const RADIO_TO_HOST = 0x03;

/** The script's per-model handshake bytes. */
interface ModelBytes {
  /** command2[0][0:4], also the expected response. */
  id: number[];
  /** Default encodeKey. */
  key: number[];
  /** command4. */
  group: number[];
  /** command5. */
  model: number[];
}

const MODEL_BYTES: Record<Gd77Model, ModelBytes> = {
  'GD-77': {
    id: [0x44, 0x56, 0x30, 0x31],
    key: [0x61 + 0x00, 0x61 + 0x0c, 0x61 + 0x0d, 0x61 + 0x01],
    group: [0x53, 0x47, 0x2d, 0x4d, 0x44, 0x2d, 0x37, 0x36, 0x30, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    model: [0x4d, 0x44, 0x2d, 0x37, 0x36, 0x30, 0xff, 0xff],
  },
  'DM-1801': {
    id: [0x44, 0x56, 0x30, 0x33],
    key: [0x74, 0x21, 0x44, 0x39],
    group: [0x42, 0x46, 0x2d, 0x44, 0x4d, 0x52, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    model: [0x31, 0x38, 0x30, 0x31, 0xff, 0xff, 0xff, 0xff],
  },
};

const OK = [0x41];
const DOWNLOAD = [0x44, 0x4f, 0x57, 0x4e, 0x4c, 0x4f, 0x41, 0x44];
const UPDATE = [0x23, 0x55, 0x50, 0x44, 0x41, 0x54, 0x45, 0x3f];
const F_PROG = [0x46, 0x2d, 0x50, 0x52, 0x4f, 0x47, 0xff, 0xff];
const VERSION = [0x56, 0x31, 0x2e, 0x30, 0x30, 0x2e, 0x30, 0x31];
const F_ERASE = [0x46, 0x2d, 0x45, 0x52, 0x41, 0x53, 0x45, 0xff];
const PROGRAM = [0x50, 0x52, 0x4f, 0x47, 0x52, 0x41, 0x4d, 0xf];
const END = [0x45, 0x4e, 0x44, 0xff];

/** Options for the simulated bootloader. */
export interface SimGd77Options {
  /** Which radio this is. */
  model: Gd77Model;
  /** Key the host must send; defaults to the one bin2sgl.py's header for the model has. */
  key?: Uint8Array;
  /** False makes the device use unnumbered reports, to exercise that mapping. */
  numberedReports?: boolean;
  /** Report size, not counting the report ID; 41 by default. */
  reportBytes?: number;
  /** True hides the report descriptor, as if `collections` were empty. */
  hideDescriptor?: boolean;
  /** What a protocol mistake gets: an "N" reply (default) or no reply at all. */
  onError?: 'reply' | 'silent';
  /** Corrupt the response with this index (0 = the answer to DOWNLOAD). */
  corruptResponseAt?: number;
  /** Send no response with this index. */
  dropResponseAt?: number;
}

/** Simulated GD-77 or DM-1801 bootloader. */
export class SimGd77 extends FakeHidDevice {
  /** Protocol mistakes seen, oldest first; empty after a clean flash. */
  readonly errors: string[] = [];
  /** Handshake steps accepted, in order. */
  readonly steps: string[] = [];
  /** True once F-ERASE and the ACK after it were accepted. */
  erased = false;
  /** Checksum frames accepted. */
  checksums = 0;

  private readonly options: SimGd77Options;
  private readonly numbered: boolean;
  private readonly reportSize: number;
  private readonly received: number[] = [];
  private step = 0;
  private responses = 0;
  private failed = false;
  /** Bytes received since the last accepted checksum, and their sum. */
  private pending = 0;
  private sum = 0;
  /** A checksum must come next: a kilobyte boundary or a short frame was reached. */
  private checksumDue = false;
  /** Nothing more may follow: the last checksum was not on a kilobyte boundary. */
  private finished = false;

  /** Creates a closed, blank radio. */
  constructor(options: SimGd77Options) {
    const numbered = options.numberedReports ?? true;
    const size = options.reportBytes ?? 3 + TRANSFER_LENGTH + (numbered ? 0 : 1);
    super({
      vendorId: 0x15a2,
      productId: 0x0073,
      productName: '',
      collections: options.hideDescriptor
        ? []
        : [
            {
              usagePage: 0xff00,
              usage: 0x01,
              type: 1,
              children: [],
              // Numbered: 1 and 2 host to radio, 3 and 4 radio to host. Only 1 and 3 are used.
              outputReports: numbered ? [byteReport(1, size), byteReport(2, size)] : [byteReport(0, size)],
              inputReports: numbered ? [byteReport(3, size), byteReport(4, size)] : [byteReport(0, size)],
              featureReports: [],
            },
          ],
    });
    this.options = options;
    this.numbered = numbered;
    this.reportSize = size;
  }

  /** The firmware received so far, still encrypted. */
  get payload(): Uint8Array {
    return Uint8Array.from(this.received);
  }

  /** True when data arrived and all of it is covered by an accepted checksum. */
  get complete(): boolean {
    return !this.failed && this.received.length > 0 && this.pending === 0;
  }

  /** Records a protocol mistake and answers (or not) as configured. */
  private fail(message: string): void {
    this.errors.push(message);
    this.failed = true;
    if ((this.options.onError ?? 'reply') === 'reply') this.respond([0x4e]);
  }

  /** Sends [0x03, 0x00, len_lo, len_hi, ...payload], zero-padded to the report size. */
  private respond(payload: readonly number[]): void {
    const index = this.responses++;
    if (index === this.options.dropResponseAt) return;
    const wire = new Uint8Array(this.reportSize + (this.numbered ? 1 : 0));
    wire[0] = RADIO_TO_HOST;
    wire[1] = 0x00;
    wire[2] = payload.length & 0xff;
    wire[3] = payload.length >> 8;
    wire.set(payload, 4);
    if (index === this.options.corruptResponseAt) wire[4] ^= 0x20;
    if (this.numbered) this.emitInputReport(wire[0], wire.subarray(1));
    else this.emitInputReport(0, wire);
  }

  /** Checks the frame header and padding, then hands the payload to the state machine. */
  protected onOutputReport(reportId: number, data: Uint8Array): void {
    if (this.failed) return this.fail('frame after a protocol error');
    if (this.numbered ? reportId !== HOST_TO_RADIO : reportId !== 0) {
      return this.fail(`output report ID ${reportId}`);
    }
    if (data.length !== this.reportSize) {
      return this.fail(`report of ${data.length} bytes, expected ${this.reportSize}`);
    }
    const wire = this.numbered ? Uint8Array.of(reportId, ...data) : data;
    if (wire[0] !== HOST_TO_RADIO || wire[1] !== 0x00) return this.fail('bad frame header');
    const length = wire[2] | (wire[3] << 8);
    if (4 + length > wire.length) return this.fail(`frame length ${length} does not fit the report`);
    if (wire.subarray(4 + length).some((b) => b !== 0)) return this.fail('frame padding is not zero');
    this.onFrame(wire.slice(4, 4 + length));
  }

  /** The handshake, then the data phase. */
  private onFrame(payload: Uint8Array): void {
    const bytes = MODEL_BYTES[this.options.model];
    const key = this.options.key ? Array.from(this.options.key) : bytes.key;
    const handshake: [name: string, expected: readonly number[], reply: readonly number[]][] = [
      ['DOWNLOAD', DOWNLOAD, UPDATE],
      ['ACK', OK, OK],
      ['key', [...bytes.id, ...key], bytes.id],
      ['F-PROG', F_PROG, OK],
      ['model 1', bytes.group, OK],
      ['model 2', bytes.model, OK],
      ['version', VERSION, OK],
      ['F-ERASE', F_ERASE, OK],
      ['post-erase ACK', OK, OK],
      ['PROGRAM', PROGRAM, OK],
    ];
    const expected = handshake[this.step];
    if (!expected) return this.onDataFrame(payload);
    const [name, command, reply] = expected;
    if (!same(payload, command)) return this.fail(`step "${name}": wrong command`);
    this.steps.push(name);
    this.step++;
    if (name === 'post-erase ACK') this.erased = true;
    this.respond(reply);
  }

  /** Data frames (address, length, 32 bytes) and checksum frames ("END", 0xFF, sum). */
  private onDataFrame(payload: Uint8Array): void {
    if (this.finished) return this.fail('frame after the final checksum');

    if (payload.length === 8 && same(payload.subarray(0, 4), END)) {
      if (this.pending === 0) return this.fail('checksum with no data before it');
      const sum = (payload[4] | (payload[5] << 8) | (payload[6] << 16) | (payload[7] << 24)) >>> 0;
      if (sum !== this.sum)
        return this.fail(`checksum 0x${sum.toString(16)}, expected 0x${this.sum.toString(16)}`);
      // Off a kilobyte boundary the script sends a checksum only at the very end.
      if (this.received.length % 0x400 !== 0) this.finished = true;
      this.pending = 0;
      this.sum = 0;
      this.checksumDue = false;
      this.checksums++;
      return this.respond(OK);
    }

    // The script reuses one 38-byte buffer, so every data frame has this length.
    if (payload.length !== 6 + 0x20) return this.fail(`data frame of ${payload.length} bytes`);
    if (this.checksumDue) return this.fail('data frame where a checksum was due');
    const address = ((payload[0] << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3]) >>> 0;
    const length = (payload[4] << 8) | payload[5];
    if (address !== this.received.length) {
      return this.fail(`data for 0x${address.toString(16)}, expected 0x${this.received.length.toString(16)}`);
    }
    if (length < 1 || length > 0x20) return this.fail(`data length ${length}`);
    for (const b of payload.subarray(6, 6 + length)) {
      this.received.push(b);
      this.sum += b;
    }
    this.pending += length;
    if (length < 0x20 || this.received.length % 0x400 === 0) this.checksumDue = true;
    this.respond(OK);
  }
}

/** What an .sgl header for one model holds, as decoded from bin2sgl.py's headers. */
interface SglLayout {
  /** Header length: 0x400 plus the binary offset. */
  headerBytes: number;
  /** Byte 11, the model tag the loader script checks. */
  tag: number;
  /** Where the second header starts, and its two XOR bytes. */
  offset: number;
  xor: [number, number];
  group: string;
  model: string;
  version: string;
  id: string;
  /** bin2sgl.py's key_offset into the cipher table. */
  keyOffset: number;
}

const SGL_LAYOUT: Record<Gd77Model, SglLayout> = {
  'GD-77': {
    headerBytes: 0x43a,
    tag: 0x1b,
    offset: 0xcf,
    xor: [0x58, 0xf6],
    group: 'SG-MD-760',
    model: 'MD-760',
    version: 'V1.00.01',
    id: 'DV01',
    keyOffset: 0x0807,
  },
  'DM-1801': {
    headerBytes: 0x46e,
    tag: 0x4f,
    offset: 0x9b,
    xor: [0x40, 0xe4],
    group: 'BF-DMR',
    model: '1801',
    version: 'V0.00.01',
    id: 'DV03',
    keyOffset: 0x2c7c,
  },
};

/** Stand-in for bin2sgl.py's ENCRYPTION_TABLE; deliberately not the real table. */
const TOY_TABLE = Uint8Array.from({ length: 0x3100 }, (_, i) => (i * 73 + (i >> 5) * 29 + 0x5a) & 0xff);

/** bin2sgl.py's transform_stream(): XOR with the table, rotate right by 3, invert. */
function transformStream(data: Uint8Array, keyOffset: number): Uint8Array {
  const out = new Uint8Array(data.length);
  let k = keyOffset;
  for (let i = 0; i < data.length; i++) {
    const b = data[i] ^ TOY_TABLE[k];
    out[i] = ~((b >> 3) | (b << 5)) & 0xff;
    k = k + 1 >= TOY_TABLE.length ? 0 : k + 1;
  }
  return out;
}

/** Options for buildSgl(). */
export interface BuildSglOptions {
  /** Pad the binary with 0xFF to this size, as bin2sgl.py does to 0x77001 / 0x78001. */
  payloadSize?: number;
  /** Four key bytes for the header; defaults to the model's real ones. */
  key?: Uint8Array;
}

/**
 * Builds an .sgl like bin2sgl.py's build_sgl(): a model header followed by the
 * transformed binary. The header carries what the real ones do (magic, model tag,
 * obfuscated offset, length, model strings and key); the bytes between are filler.
 */
export function buildSgl(bin: Uint8Array, model: Gd77Model, options: BuildSglOptions = {}): Uint8Array {
  const layout = SGL_LAYOUT[model];
  const padded = new Uint8Array(Math.max(options.payloadSize ?? bin.length, bin.length)).fill(0xff);
  padded.set(bin);
  const key = options.key ? Array.from(options.key) : MODEL_BYTES[model].key;
  /** Character codes of an ASCII string. */
  const text = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));
  const magic = text('SGL!');

  // Second header: length at +6, strings at +0x32/+0x42/+0x4A, key at +0x5F.
  const h2 = new Uint8Array(0x67);
  h2.set([0x02, 0x10]);
  new DataView(h2.buffer).setUint32(6, padded.length, true);
  h2.fill(0xff, 0x32, 0x4a);
  h2.set(text(layout.group), 0x32);
  h2.set(text(layout.model), 0x42);
  h2.set(text(layout.version), 0x4a);
  h2.set([...text(layout.id), ...key], 0x5f);

  const header = Uint8Array.from({ length: layout.headerBytes }, (_, i) => (i * 151 + 17) & 0xff);
  // First header: "SGL!", then 12 bytes XORed with the magic.
  const h1 = [...text('ENCV001'), 0, layout.offset & 0xff, layout.offset >> 8, ...layout.xor];
  header.set(magic);
  h1.forEach((b, i) => (header[4 + i] = b ^ magic[i % 4]));
  header[11] = layout.tag;
  h2.forEach((b, i) => (header[layout.offset + i] = b ^ layout.xor[i % 2]));

  const sgl = new Uint8Array(header.length + padded.length);
  sgl.set(header);
  sgl.set(transformStream(padded, layout.keyOffset), header.length);
  return sgl;
}
