// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Simulated Radtel RT-4D running its original firmware, as a Web Serial port, for the
 * read-only backup in src/backup/rt4d-stock.ts.
 *
 * It answers the block read exactly as RT-4D-SPIFlash-CLI by Dual Tachyon expects
 * (https://github.com/DualTachyon/rt-4d-spiflash-cli, RT-4D-UART.cs, Apache-2.0):
 * `52 blkH blkL cs` gets 3 header bytes, 1024 data bytes and a checksum, where every
 * checksum is the plain 8-bit sum of the bytes before it.
 *
 * Not in that tool, and taken from Dual Tachyon's open firmware for the sibling RT-890
 * (https://github.com/DualTachyon/radtel-rt-890-oefw, app/uart.c, Apache-2.0), which
 * speaks the same protocol with 128-byte blocks: the header repeats the request
 * (`52 blkH blkL`), a packet with a bad checksum gets `FF`, and the "notify" command
 * only answers `06`. Invented here: what a read past the end of the chip returns
 * (0xFF bytes), how many `FF` a bootloader sends back, and the two ways a firmware
 * might refuse the blocks above the first 4 MiB (`wrapBlocks`, `silentFrom`).
 *
 * Nothing that could change the radio is ever acted on. Region writes (0x40,
 * 0x90-0xA5), the bootloader's erase and write (0x39, 0x57) and anything unknown are
 * recorded in `forbidden` and dropped.
 */
import { FakeSerialPort } from './serial.ts';

const CMD_SESSION = 0x34;
const CMD_READ = 0x52;
const ACK = 0x06;
const REFUSED = 0xff;
const BLOCK = 0x400;

/** Size of the RT-4D's SPI flash chip. */
export const SIM_RT4D_SPI_FLASH_SIZE = 0x1000000;

/** A fault on the reply to one block. */
export interface SimRt4dStockFault {
  /** Block index (address / 1024) the fault applies to. */
  block: number;
  /** How many replies to that block are affected; Infinity means every one. */
  times?: number;
}

/** Options for the simulated radio. */
export interface SimRt4dStockOptions {
  /** Bytes of SPI flash; 16 MiB by default. */
  flashSize?: number;
  /** Seed of the deterministic flash contents. */
  seed?: number;
  /**
   * 'stock' runs the original firmware (default); 'bootloader' answers like a radio in
   * flashing mode; 'silent' never answers, like a radio that is off.
   */
  mode?: 'stock' | 'bootloader' | 'silent';
  /** What the bootloader sends back to a read; a lone 0xFF by default. */
  bootloaderReply?: number[];
  /** Flip a bit in the checksum of this block's reply (once unless `times` says otherwise). */
  corruptChecksum?: SimRt4dStockFault;
  /** Answer this block with the header of the next one, checksum adjusted to match. */
  wrongHeader?: SimRt4dStockFault;
  /** Send no reply to this block (never unless `times` says otherwise). */
  drop?: SimRt4dStockFault;
  /** Deliver replies in pieces of this many bytes. */
  chunkBytes?: number;
  /** Bytes the port already has waiting when it is opened. */
  noise?: number[];
  /**
   * Look at the block index modulo this many blocks, like a firmware that decodes fewer
   * address bits than the request carries. Not seen on a radio; the reader must notice.
   */
  wrapBlocks?: number;
  /** Send no reply to this block or any after it, like a firmware that serves only the start of the chip. */
  silentFrom?: number;
}

/** Deterministic, non-repeating filler for the flash. */
function fillPattern(out: Uint8Array, seed: number): void {
  let x = (seed * 2654435761) >>> 0;
  for (let i = 0; i < out.length; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
}

/** Plain 8-bit sum, the checksum of the original firmware's protocol. */
function sum8(bytes: ArrayLike<number>, length: number): number {
  let sum = 0;
  for (let i = 0; i < length; i++) sum += bytes[i];
  return sum & 0xff;
}

/** Simulated RT-4D in normal mode, with its original firmware. */
export class SimRt4dStock extends FakeSerialPort {
  /** The SPI flash; tests may change it before reading. */
  readonly flash: Uint8Array;
  /** Commands that could have changed the radio, oldest first. Must stay empty. */
  readonly forbidden: string[] = [];
  /** Protocol mistakes that could not have changed anything, oldest first. */
  readonly errors: string[] = [];
  /** Block index of every read request with a good checksum, in order. */
  readonly reads: number[] = [];
  /** "Notify" commands (34 00 00 10) answered. */
  notifies = 0;
  /** "Close" commands (34 52 05 EE) seen. */
  closes = 0;

  private rx: number[] = [];
  private readonly faults = new Map<SimRt4dStockFault, number>();

  /** Creates a closed port with a radio full of deterministic data behind it. */
  constructor(private readonly options: SimRt4dStockOptions = {}) {
    // A CP2102, as in common programming cables.
    super({ usbVendorId: 0x10c4, usbProductId: 0xea60 });
    this.flash = new Uint8Array(options.flashSize ?? SIM_RT4D_SPI_FLASH_SIZE);
    fillPattern(this.flash, options.seed ?? 1);
  }

  /** SerialPort.open(), plus any line noise that was waiting. */
  override async open(options: SerialOptions): Promise<void> {
    await super.open(options);
    if (this.options.noise) this.respond(this.options.noise);
  }

  /** True while `fault` still applies to `block`; counts the use. */
  private hit(fault: SimRt4dStockFault | undefined, block: number, defaultTimes: number): boolean {
    if (fault?.block !== block) return false;
    const used = this.faults.get(fault) ?? 0;
    if (used >= (fault.times ?? defaultTimes)) return false;
    this.faults.set(fault, used + 1);
    return true;
  }

  /** Sends a reply, whole or in pieces; nothing in silent mode. */
  private reply(bytes: Uint8Array): void {
    if (this.options.mode === 'silent') return;
    const size = this.options.chunkBytes ?? bytes.length;
    for (let at = 0; at < bytes.length; at += size) this.respond(bytes.subarray(at, at + size));
  }

  /** Records a command that could write and throws away what came with it. */
  private forbid(what: string): void {
    this.forbidden.push(what);
    this.rx = [];
  }

  /** Splits the byte stream into packets by their first byte. */
  protected onData(bytes: Uint8Array): void {
    this.rx.push(...bytes);
    while (this.rx.length > 0) {
      const command = this.rx[0];
      const id = `0x${command.toString(16).padStart(2, '0')}`;
      if (command === 0x40 || (command >= 0x90 && command <= 0xa5)) {
        return this.forbid(`region write ${id}`);
      }
      if (command === 0x39) return this.forbid('bootloader erase 0x39');
      if (command === 0x57) return this.forbid('bootloader write 0x57');
      if (command !== CMD_READ && command !== CMD_SESSION) return this.forbid(`unknown command ${id}`);
      const length = command === CMD_READ ? 4 : 5;
      if (this.rx.length < length) return;
      this.onPacket(this.rx.splice(0, length));
    }
  }

  /** Checks one whole read or session packet and answers it. */
  private onPacket(packet: number[]): void {
    const mode = this.options.mode ?? 'stock';
    if (mode === 'silent') return;
    if (mode === 'bootloader') {
      // The bootloader's checksum has another seed, so to it this packet is noise.
      return this.reply(Uint8Array.from(this.options.bootloaderReply ?? [REFUSED]));
    }
    if (sum8(packet, packet.length - 1) !== packet[packet.length - 1]) {
      this.errors.push(`bad checksum on command 0x${packet[0].toString(16)}`);
      return this.reply(Uint8Array.of(REFUSED));
    }
    if (packet[0] === CMD_SESSION) return this.onSession(packet);

    const block = (packet[1] << 8) | packet[2];
    this.reads.push(block);
    if (this.hit(this.options.drop, block, Infinity)) return;
    if (this.options.silentFrom !== undefined && block >= this.options.silentFrom) return;
    const from = block % (this.options.wrapBlocks ?? 0x10000);
    const answer = new Uint8Array(3 + BLOCK + 1).fill(0xff, 3);
    const shown = this.hit(this.options.wrongHeader, block, 1) ? block + 1 : block;
    answer[0] = CMD_READ;
    answer[1] = (shown >> 8) & 0xff;
    answer[2] = shown & 0xff;
    // Past the end of the chip the 0xFF filler stays.
    answer.set(this.flash.subarray(from * BLOCK, (from + 1) * BLOCK), 3);
    answer[3 + BLOCK] = sum8(answer, 3 + BLOCK);
    if (this.hit(this.options.corruptChecksum, block, 1)) answer[3 + BLOCK] ^= 0x10;
    this.reply(answer);
  }

  /** The two session commands of the reference tool; neither is needed for reading. */
  private onSession(packet: number[]): void {
    if (packet[1] === 0x00 && packet[2] === 0x00 && packet[3] === 0x10) {
      this.notifies++;
      return this.reply(Uint8Array.of(ACK));
    }
    if (packet[1] === 0x52 && packet[2] === 0x05 && packet[3] === 0xee) {
      // The reference tool expects no answer; a real radio may restart here.
      this.closes++;
      return;
    }
    this.forbid(`unknown session command 34 ${packet.slice(1, 4).join(' ')}`);
  }
}
