// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Simulated Radtel RT-950 Pro in normal mode, running Radtel's firmware, as a Web
 * Serial port, for the read-only backup in src/backup/rt950-stock.ts.
 *
 * It follows the programming session as cps_flash.py in Hertzz58's
 * Radtel-RT950-Pro-Firmware has it (tools/cps_flash.py, GPL-3.0): the handshake
 * string, `F` for 16 bytes of identity, `M` for the 12-byte model name, the 25-byte
 * `SEND` packet that picks one of twenty keys, then `52 addrH addrL len` reads answered
 * with the same four bytes and the scrambled data, and a lone `06` to end.
 *
 * It is strict about the session: every step must come in that order, and a read
 * before the key exchange is a mistake. Anything that could change the radio (the
 * write, write-end and erase commands `57`, `58` and `45`) is recorded in `forbidden`
 * and dropped. Invented here: that the radio is silent to anything it does not expect,
 * that the closing `06` also ends a session that never got as far as the key exchange,
 * and what its identity bytes are.
 */
import { FakeSerialPort } from './serial.ts';
import { fillPattern } from './support.ts';

const HANDSHAKE = 'PROGRAMBT9000U';
const ACK = 0x06;
const CMD_READ = 0x52;
const BLOCK = 128;
const KEYS = [
  'BHT ',
  'CO 7',
  'A ES',
  ' EIY',
  'M PQ',
  'XN Y',
  'RVB ',
  ' HQP',
  'W RC',
  'MS N',
  ' SAT',
  'K DH',
  'ZO R',
  'C SL',
  '6RB ',
  ' JCG',
  'PN V',
  'J PK',
  'EK L',
  'I LZ',
];

/** How much of the memory chip the 16-bit address reaches. */
export const SIM_RT950_STOCK_BYTES = 0x10000;

/** Options for the simulated radio. */
export interface SimRt950StockOptions {
  /** Seed of the deterministic memory contents. */
  seed?: number;
  /** 'stock' runs Radtel's firmware (default); 'silent' never answers, like a radio that is off or in flashing mode. */
  mode?: 'stock' | 'silent';
  /** The model name the radio gives; "RT-950" by default. */
  model?: string;
  /** Answer the handshake with this byte instead of ACK. */
  handshakeReply?: number;
  /** Send no answer to the first request for the block at this address. */
  dropAt?: number;
  /** Answer the first request for the block at this address as if it were for the next block. */
  wrongAddressAt?: number;
  /** Never answer requests for the block at this address. */
  deadAt?: number;
  /** Deliver answers in pieces of this many bytes. */
  chunkBytes?: number;
  /** Bytes the port already has waiting when it is opened. */
  noise?: number[];
}

/** The scrambling of the programming protocol; the same steps go both ways. */
function scramble(data: Uint8Array, key: Uint8Array): Uint8Array {
  return data.map((b, i) => {
    const k = key[i % 4];
    return k === 0x20 || b === 0x00 || b === 0xff || b === k || b === (k ^ 0xff) ? b : b ^ k;
  });
}

/** Simulated RT-950 Pro in normal mode, with Radtel's firmware. */
export class SimRt950Stock extends FakeSerialPort {
  /** The first 64 KiB of the memory chip; tests may change it before reading. */
  readonly flash = new Uint8Array(SIM_RT950_STOCK_BYTES);
  /** Commands that could have changed the radio, oldest first. Must stay empty. */
  readonly forbidden: string[] = [];
  /** Protocol mistakes that could not have changed anything, oldest first. */
  readonly errors: string[] = [];
  /** Address of every read request answered or deliberately not answered, in order. */
  readonly reads: number[] = [];
  /** Programming sessions opened. */
  sessions = 0;
  /** Sessions ended with the closing 06. */
  ended = 0;
  /** What the radio says when asked to identify itself. */
  readonly identity = Uint8Array.from({ length: 16 }, (_, i) => 0x30 + i);

  private rx: number[] = [];
  private stage: 'idle' | 'identity' | 'model' | 'key' | 'data' = 'idle';
  private key: Uint8Array = new Uint8Array(4);
  private readonly faulted = new Set<string>();

  /** Creates a closed port with a radio full of deterministic data behind it. */
  constructor(private readonly options: SimRt950StockOptions = {}) {
    // A CH340, as in common programming cables.
    super({ usbVendorId: 0x1a86, usbProductId: 0x7523 });
    fillPattern(this.flash, options.seed ?? 1);
  }

  /** SerialPort.open(), plus any line noise that was waiting. */
  override async open(options: SerialOptions): Promise<void> {
    await super.open(options);
    if (this.options.noise) this.respond(this.options.noise);
  }

  /** Sends an answer, whole or in pieces. */
  private reply(bytes: ArrayLike<number>): void {
    const all = Array.from(bytes);
    const size = this.options.chunkBytes ?? all.length;
    for (let at = 0; at < all.length; at += size) this.respond(all.slice(at, at + size));
  }

  /** True the first time it is asked about this fault at this address. */
  private once(fault: string, at: number): boolean {
    const name = `${fault}:${at}`;
    if (this.faulted.has(name)) return false;
    this.faulted.add(name);
    return true;
  }

  /** Takes the bytes the host sent and answers what is complete. */
  protected onData(bytes: Uint8Array): void {
    if (this.options.mode === 'silent') return;
    this.rx.push(...bytes);
    for (;;) {
      const before = this.rx.length;
      this.step();
      if (this.rx.length === before || this.rx.length === 0) return;
    }
  }

  /** Handles one complete step of the session, if the bytes for it are in. */
  private step(): void {
    const { rx } = this;
    if (this.stage === 'idle') {
      if (rx.length < HANDSHAKE.length) return;
      const sent = String.fromCharCode(...rx.splice(0, HANDSHAKE.length));
      if (sent !== HANDSHAKE) {
        this.errors.push('something other than the handshake while idle');
        this.rx = [];
        return;
      }
      this.sessions++;
      this.stage = 'identity';
      return this.reply([this.options.handshakeReply ?? ACK]);
    }
    // The closing 06 ends a session wherever it has got to.
    if (rx[0] === ACK && this.stage !== 'data') {
      rx.shift();
      this.ended++;
      this.stage = 'idle';
      return;
    }
    if (this.stage === 'identity' || this.stage === 'model') {
      const wanted = this.stage === 'identity' ? 'F' : 'M';
      const got = String.fromCharCode(rx.shift()!);
      if (got !== wanted) return this.mistake(`"${got}" where "${wanted}" was due`);
      if (this.stage === 'identity') {
        this.stage = 'model';
        return this.reply(this.identity);
      }
      this.stage = 'key';
      const model = new Uint8Array(12);
      model.set(new TextEncoder().encode(this.options.model ?? 'RT-950'));
      return this.reply(model);
    }
    if (this.stage === 'key') {
      if (rx.length < 25) return;
      const packet = rx.splice(0, 25);
      const selector = packet[4];
      const lo = selector & 0x0f;
      const hi = selector >> 4;
      if (String.fromCharCode(...packet.slice(0, 4)) !== 'SEND')
        return this.mistake('key packet without SEND');
      if ((hi !== 1 && hi !== 2) || lo > 4) return this.mistake(`key selector 0x${selector.toString(16)}`);
      if (packet.slice(5, 24).some((b) => b > 19) || packet[24] !== 0) {
        return this.mistake('key packet with a value that is not a table index');
      }
      const index = (hi === 2 ? lo * 2 + 1 : lo * 2) + 1;
      this.key = new TextEncoder().encode(KEYS[packet[4 + index]]);
      this.stage = 'data';
      return this.reply([ACK]);
    }

    // In the session: reads, the closing 06, and what must never be sent.
    const command = rx[0];
    if (command === ACK) {
      rx.shift();
      this.ended++;
      this.stage = 'idle';
      return;
    }
    if (command !== CMD_READ) {
      this.forbidden.push(`command 0x${command.toString(16)} in a session`);
      this.rx = [];
      return;
    }
    if (rx.length < 4) return;
    const [, addrHigh, addrLow, length] = rx.splice(0, 4);
    const at = (addrHigh << 8) | addrLow;
    if (length === 0 || length > BLOCK) return this.mistake(`read of ${length} bytes`);
    if (at + length > SIM_RT950_STOCK_BYTES) return this.mistake('read past the end of the address range');
    this.reads.push(at);
    if (at === this.options.deadAt) return;
    if (at === this.options.dropAt && this.once('drop', at)) return;
    const shown = at === this.options.wrongAddressAt && this.once('wrong', at) ? at + BLOCK : at;
    this.reply([
      CMD_READ,
      (shown >> 8) & 0xff,
      shown & 0xff,
      length,
      ...scramble(this.flash.subarray(at, at + length), this.key),
    ]);
  }

  /** Records a protocol mistake and forgets what was sent. */
  private mistake(message: string): void {
    this.errors.push(message);
    this.rx = [];
  }
}
