// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Simulated Radtel RT-4D bootloader as a Web Serial port.
 *
 * It is strict: it accepts exactly the conversation fagci's RT-4D flasher
 * (https://github.com/fagci/RT-4D-python-flasher, rt_4d_flasher.py, GPL-3.0) has with
 * the radio. The checksum of every packet must be right, the probe comes first, both
 * erase commands must precede the first write, and the 246 blocks must arrive in order
 * with the offset field the reference sends. After the first mistake it answers
 * nothing but NAK.
 *
 * Not known from the reference, and so invented here: how long the probe reply is
 * (the reference reads up to 4 bytes and checks the first), what the bootloader says
 * to a bad packet (0x15 here, or silence), and that it insists on this order at all.
 */
import { FakeSerialPort } from './serial.ts';

const CMD_ERASE_FLASH = 0x39;
const CMD_READ_FLASH = 0x52;
const CMD_WRITE_FLASH = 0x57;
const ACK = 0x06;
const BLOCK = 0x400;
/** Flash the bootloader lets the host write: 0x08002800 up to the end of 256 KiB. */
export const SIM_RT4D_MEMORY_SIZE = 0x3d800;

/** Options for the simulated bootloader. */
export interface SimRt4dOptions {
  /** Never answer, like a radio that is off or running its normal firmware. */
  silent?: boolean;
  /** Reply to the probe; the first byte 0xFF means "in flashing mode". */
  probeReply?: number[];
  /** Deliver multi-byte replies one byte per chunk. */
  splitReplies?: boolean;
  /** What a bad packet gets: this byte (default 0x15), or nothing when null. */
  nak?: number | null;
  /** Answer NAK to the write of this block index even though it is fine. */
  nakBlock?: number;
  /** Answer NAK to this erase command (0 or 1). */
  nakErase?: number;
  /** Flip a bit in the write packet with this block index, like line noise. */
  corruptBlock?: number;
  /** Bytes the port already has waiting when it is opened. */
  noise?: number[];
}

/** Simulated RT-4D in bootloader mode. */
export class SimRt4d extends FakeSerialPort {
  /** The writable flash; offset 0 is 0x08002800. Erased bytes read 0xFF. */
  readonly flash = new Uint8Array(SIM_RT4D_MEMORY_SIZE).fill(0xff);
  /** Protocol mistakes seen, oldest first; empty after a clean flash. */
  readonly errors: string[] = [];
  /** The 16-bit offset field of every accepted write, in order. */
  readonly offsets: number[] = [];
  /** Probes answered. */
  probes = 0;
  /** Erase commands accepted (2 after a full erase). */
  erases = 0;
  /** Blocks written. */
  blocks = 0;

  private rx: number[] = [];
  private failed = false;
  private writes = 0;

  /** Creates a closed port with a blank radio behind it. */
  constructor(private readonly options: SimRt4dOptions = {}) {
    // A CP2102, as in common programming cables.
    super({ usbVendorId: 0x10c4, usbProductId: 0xea60 });
  }

  /** True when every block has been written. */
  get complete(): boolean {
    return !this.failed && this.blocks === SIM_RT4D_MEMORY_SIZE / BLOCK;
  }

  /** SerialPort.open(), plus any line noise that was waiting. */
  override async open(options: SerialOptions): Promise<void> {
    await super.open(options);
    if (this.options.noise) this.respond(this.options.noise);
  }

  /** Sends a reply, whole or byte by byte. */
  private reply(bytes: number[]): void {
    if (this.options.silent) return;
    if (this.options.splitReplies) for (const b of bytes) this.respond([b]);
    else this.respond(bytes);
  }

  /** Records a protocol mistake; from here on every packet is refused. */
  private fail(message: string): void {
    this.errors.push(message);
    this.failed = true;
    this.rx = [];
    this.refuse();
  }

  /** Answers NAK, or nothing when so configured. */
  private refuse(): void {
    const nak = this.options.nak === undefined ? 0x15 : this.options.nak;
    if (nak !== null) this.reply([nak]);
  }

  /** Splits the byte stream into packets by their first byte. */
  protected onData(bytes: Uint8Array): void {
    if (this.options.silent) return;
    this.rx.push(...bytes);
    for (;;) {
      if (this.rx.length === 0) return;
      const command = this.rx[0];
      const length =
        command === CMD_READ_FLASH
          ? 4
          : command === CMD_ERASE_FLASH
            ? 5
            : command === CMD_WRITE_FLASH
              ? 4 + BLOCK
              : 0;
      if (length === 0) return this.fail(`unknown command 0x${command.toString(16)}`);
      if (this.rx.length < length) return;
      this.onPacket(this.rx.splice(0, length));
    }
  }

  /** Checks one whole packet and acts on it. */
  private onPacket(packet: number[]): void {
    if (this.failed) return this.refuse();
    const [command, a, b] = packet;
    if (command === CMD_WRITE_FLASH && this.writes++ === this.options.corruptBlock) packet[100] ^= 0x04;

    const body = packet.slice(0, -1);
    const sum = (body.reduce((s, v) => s + v, 0) + 72) & 0xff;
    if (sum !== packet[packet.length - 1])
      return this.fail(`bad checksum on command 0x${command.toString(16)}`);

    if (command === CMD_READ_FLASH) {
      if (a !== 0 || b !== 0) return this.fail('probe with a non-zero offset');
      this.probes++;
      return this.reply(this.options.probeReply ?? [0xff, 0xff, 0xff, 0xff]);
    }
    if (this.probes === 0) return this.fail('command before the probe');

    if (command === CMD_ERASE_FLASH) {
      // A new erase pair after a finished one starts the radio over.
      if (this.erases === 2) this.erases = 0;
      const expected = [0x33, 0x05, this.erases === 0 ? 0x10 : 0x55];
      if (!expected.every((v, i) => v === packet[1 + i])) {
        return this.fail(`unexpected erase command #${this.erases}`);
      }
      if (this.erases === this.options.nakErase) return this.refuse();
      this.erases++;
      if (this.erases === 2) {
        this.flash.fill(0xff);
        this.blocks = 0;
      }
      return this.reply([ACK]);
    }

    // CMD_WRITE_FLASH
    if (this.erases < 2) return this.fail('write before the flash was erased');
    if (this.blocks >= SIM_RT4D_MEMORY_SIZE / BLOCK) return this.fail('write past the end of the flash');
    const field = (a << 8) | b;
    // The reference sends the low 16 bits of the byte offset, which wrap every 64 KiB.
    const expected = (this.blocks * BLOCK) & 0xffff;
    if (field !== expected) {
      return this.fail(`write offset field 0x${field.toString(16)}, expected 0x${expected.toString(16)}`);
    }
    if (this.blocks === this.options.nakBlock) return this.refuse();
    this.flash.set(packet.slice(3, 3 + BLOCK), this.blocks * BLOCK);
    this.offsets.push(field);
    this.blocks++;
    this.reply([ACK]);
  }
}
