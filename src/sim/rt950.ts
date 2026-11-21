// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Simulated Radtel RT-950 Pro bootloader as a Web Serial port.
 *
 * It is strict: it accepts exactly the conversation Marko13's rt950_flash.py
 * (https://github.com/Marko13-dev/OpenRTX, branch rt950pro, scripts/) has with a radio
 * that was switched on in the bootloader. Every packet must be framed and carry the
 * right CRC, the version, the model and the block count come before the data in that
 * order, and the blocks arrive in order, each 1 KiB. A block may be sent again, as the
 * reference does after a lost answer. After the first mistake it answers nothing.
 *
 * Known from the reference: the framing, the result codes, that the probe is answered
 * 0xE5 in this mode, and one captured answer, which fixes how the answer's CRC is
 * made. Invented here: that the bootloader insists on this order, what it says to a
 * wrong version string (0xE5) and that it goes quiet after a bad frame.
 */
import { FakeSerialPort } from './serial.ts';

const HEADER = 0xaa;
const FOOTER = 0x55;
const CMD_PROBE = 0x42;
const CMD_VERSION = 0x0a;
const CMD_MODEL = 0x02;
const CMD_PKG_COUNT = 0x04;
const CMD_DATA = 0x03;
const CMD_END = 0x45;
const ACK = 0x06;
const WRONG_LENGTH = 0xe1;
const NOT_APPLICABLE = 0xe5;
const MODEL_MISMATCH = 0xe6;
const BLOCK = 1024;
const MODEL = 'RT-950      ';

/** Options for the simulated bootloader. */
export interface SimRt950Options {
  /** Never answer, like a radio that is off or running its normal firmware. */
  silent?: boolean;
  /** Do not answer the probe, though the rest works. */
  quietProbe?: boolean;
  /** Deliver answers one byte per chunk. */
  splitReplies?: boolean;
  /** Bytes the port already has waiting when it is opened. */
  noise?: number[];
  /** Give no answer to the first arrival of the block with this number. */
  dropBlock?: number;
  /** Answer "wrong data length" to the first arrival of the block with this number. */
  lengthErrorBlock?: number;
  /** Store the block with this number but lose the answer to its first arrival. */
  loseAnswerBlock?: number;
  /** Answer "wrong data length" to every arrival of the block with this number. */
  refuseBlock?: number;
  /** Answer this code instead of ACK to the end command. */
  endResult?: number;
}

/** CRC-CCITT, polynomial 0x1021, starting from 0. */
function crc16(bytes: number[]): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
  }
  return crc;
}

/** Simulated RT-950 Pro in its bootloader. */
export class SimRt950 extends FakeSerialPort {
  /** The file as received, block after block. */
  received = new Uint8Array(0);
  /** Protocol mistakes seen, oldest first; empty after a clean flash. */
  readonly errors: string[] = [];
  /** The block number of every data packet that arrived, in order, repeats included. */
  readonly arrivals: number[] = [];
  /** Probes answered. */
  probes = 0;
  /** Blocks the host announced. */
  expected = 0;
  /** Blocks stored. */
  blocks = 0;
  /** True once the end command was accepted. */
  ended = false;

  private rx: number[] = [];
  private failed = false;
  private stage: 'version' | 'model' | 'count' | 'data' = 'version';
  private readonly seen = new Set<number>();

  /** Creates a closed port with a radio in its bootloader behind it. */
  constructor(private readonly options: SimRt950Options = {}) {
    // A CH340, as in common programming cables.
    super({ usbVendorId: 0x1a86, usbProductId: 0x7523 });
  }

  /** True when every announced block arrived and the update was ended. */
  get complete(): boolean {
    return !this.failed && this.ended && this.expected > 0 && this.blocks === this.expected;
  }

  /** SerialPort.open(), plus any line noise that was waiting. */
  override async open(options: SerialOptions): Promise<void> {
    await super.open(options);
    if (this.options.noise) this.respond(this.options.noise);
  }

  /** Sends the 9-byte answer to `command` with this result code. */
  private answer(command: number, result: number): void {
    if (this.options.silent) return;
    const body = [command, 0x00, result, 0x00, 0x00];
    const crc = crc16(body);
    const bytes = [HEADER, ...body, crc >> 8, crc & 0xff, FOOTER];
    if (this.options.splitReplies) for (const b of bytes) this.respond([b]);
    else this.respond(bytes);
  }

  /** Records a protocol mistake; from here on nothing is answered. */
  private fail(message: string): void {
    this.errors.push(message);
    this.failed = true;
    this.rx = [];
  }

  /** Splits the byte stream into framed packets. */
  protected onData(bytes: Uint8Array): void {
    if (this.options.silent || this.failed) return;
    this.rx.push(...bytes);
    for (;;) {
      if (this.rx.length === 0) return;
      if (this.rx[0] !== HEADER) return this.fail(`packet starts with 0x${this.rx[0].toString(16)}`);
      if (this.rx.length < 6) return;
      const length = (this.rx[4] << 8) | this.rx[5];
      if (this.rx.length < length + 9) return;
      this.onPacket(this.rx.splice(0, length + 9));
      if (this.failed) return;
    }
  }

  /** Checks one whole packet and acts on it. */
  private onPacket(packet: number[]): void {
    const command = packet[1];
    const argument = (packet[2] << 8) | packet[3];
    const data = packet.slice(6, -3);
    if (packet[packet.length - 1] !== FOOTER) return this.fail('packet does not end with 0x55');
    const crc = crc16(packet.slice(1, -3));
    if (crc !== ((packet[packet.length - 3] << 8) | packet[packet.length - 2])) {
      return this.fail(`bad CRC on command 0x${command.toString(16)}`);
    }

    if (command === CMD_PROBE) {
      if (this.options.quietProbe) return;
      this.probes++;
      return this.answer(command, NOT_APPLICABLE);
    }
    if (command === CMD_VERSION) {
      if (this.stage !== 'version') return this.fail('version sent twice');
      if (String.fromCharCode(...data) !== 'BOOTLOADER_V3') return this.answer(command, NOT_APPLICABLE);
      this.stage = 'model';
      return this.answer(command, ACK);
    }
    if (command === CMD_MODEL) {
      if (this.stage !== 'model') return this.fail('model sent out of order');
      if (data.length !== 32) return this.answer(command, WRONG_LENGTH);
      if (String.fromCharCode(...data.slice(0, MODEL.length)) !== MODEL) {
        return this.answer(command, MODEL_MISMATCH);
      }
      this.stage = 'count';
      return this.answer(command, ACK);
    }
    if (command === CMD_PKG_COUNT) {
      if (this.stage !== 'count') return this.fail('block count sent out of order');
      if (data.length !== 2) return this.answer(command, WRONG_LENGTH);
      // The host sends the number of the last block.
      this.expected = ((data[0] << 8) | data[1]) + 1;
      this.received = new Uint8Array(this.expected * BLOCK);
      this.stage = 'data';
      return this.answer(command, ACK);
    }
    if (command === CMD_DATA) {
      if (this.stage !== 'data') return this.fail('data before the block count');
      if (this.ended) return this.fail('data after the end of the update');
      this.arrivals.push(argument);
      const first = !this.seen.has(argument);
      this.seen.add(argument);
      if (first && argument === this.options.dropBlock) return;
      if (argument === this.options.refuseBlock) return this.answer(command, WRONG_LENGTH);
      if (first && argument === this.options.lengthErrorBlock) return this.answer(command, WRONG_LENGTH);
      if (data.length !== BLOCK) return this.answer(command, WRONG_LENGTH);
      // The next block, or the one before it again.
      if (argument !== this.blocks && argument !== this.blocks - 1) {
        return this.fail(`block ${argument} arrived when block ${this.blocks} was due`);
      }
      this.received.set(data, argument * BLOCK);
      if (argument === this.blocks) this.blocks++;
      if (first && argument === this.options.loseAnswerBlock) return;
      return this.answer(command, ACK);
    }
    if (command === CMD_END) {
      if (this.stage !== 'data' || this.blocks !== this.expected) {
        return this.fail('end of the update before every block arrived');
      }
      this.ended = true;
      return this.answer(command, this.options.endResult ?? ACK);
    }
    this.fail(`unknown command 0x${command.toString(16)}`);
  }
}
