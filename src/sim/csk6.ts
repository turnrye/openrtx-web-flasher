// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Simulated LISTENAI CSK6 (Retevis C62) in flashing mode, as a Web Serial port.
 *
 * Speaks the SLIP-framed protocol cskburn uses with the boot ROM and its RAM burner,
 * keeps a flash image, and records the commands it saw. It answers only well-formed
 * requests, so a flasher that sends the wrong thing stalls and fails.
 */

const END = 0xc0;
const ESC = 0xdb;
const ESC_END = 0xdc;
const ESC_ESC = 0xdd;

const NAMES: Record<number, string> = {
  0x02: 'FLASH_BEGIN',
  0x03: 'FLASH_DATA',
  0x04: 'FLASH_END',
  0x05: 'MEM_BEGIN',
  0x06: 'MEM_END',
  0x07: 'MEM_DATA',
  0x08: 'SYNC',
  0x0e: 'READ_FLASH',
  0x0f: 'CHANGE_BAUD',
  0x13: 'MD5',
  0xd1: 'ERASE_REGION',
  0xf3: 'FLASH_ID',
  0xf4: 'CHIP_ID',
};

/** Wraps one packet in SLIP framing. */
function slipEncode(packet: Uint8Array): Uint8Array {
  const out = [END];
  for (const b of packet) {
    if (b === END) out.push(ESC, ESC_END);
    else if (b === ESC) out.push(ESC, ESC_ESC);
    else out.push(b);
  }
  out.push(END);
  return Uint8Array.from(out);
}

/** Options for the simulated chip. */
export interface SimCsk6Options {
  /** Flash size in bytes; the C62 has 4 MiB. */
  flashSize?: number;
  /** MD5 over a byte range; injected because Node and browsers differ. */
  md5: (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>;
  /** When true the chip never answers, like a radio that is not in flashing mode. */
  silent?: boolean;
  /** Corrupt this flash offset after writing, so verification must fail. */
  corruptAt?: number;
  /** Hand back wrong bytes when flash is read, so a backup must fail its check. */
  corruptReads?: boolean;
  /** How long the chip takes to answer each command; 0 when left out. */
  replyDelayMs?: number;
}

/** Simulated C62 behind a USB serial adapter. */
export class SimCsk6 {
  readonly flash: Uint8Array;
  /** Burner image the host uploaded with MEM_DATA. */
  readonly ram: number[] = [];
  /** Commands seen, run-length encoded: "SYNC x1", "FLASH_DATA x76". */
  readonly trace: string[] = [];
  /** Baud rates the host opened the port at. */
  readonly opens: number[] = [];
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;

  private rx: number[] = [];
  private frame: number[] | null = null;
  private escaped = false;
  private flashBase = 0;
  private flashBlock = 0;
  private notify: (() => void) | null = null;

  constructor(private readonly options: SimCsk6Options) {
    this.flash = new Uint8Array(options.flashSize ?? 4 << 20).fill(0xff);
  }

  /** SerialPort.getInfo(): a CP2102N, like the Digirig cable. */
  getInfo(): SerialPortInfo {
    return { usbVendorId: 0x10c4, usbProductId: 0xea60 };
  }

  /** SerialPort.open(). */
  async open(options: SerialOptions): Promise<void> {
    if (this.readable) throw new DOMException('The port is already open.', 'InvalidStateError');
    this.opens.push(options.baudRate);
    let cancelled = false;
    this.readable = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        while (this.rx.length === 0 && !cancelled) {
          await new Promise<void>((resolve) => {
            this.notify = resolve;
            setTimeout(resolve, 20);
          });
        }
        if (cancelled) controller.close();
        else controller.enqueue(Uint8Array.from(this.rx.splice(0, 4096)));
      },
      cancel: () => {
        cancelled = true;
        this.notify?.();
      },
    });
    this.writable = new WritableStream<Uint8Array>({ write: (chunk) => this.receive(chunk) });
  }

  /** SerialPort.close(); like Chrome, refuses while a stream is locked. */
  async close(): Promise<void> {
    if (!this.readable || !this.writable) return;
    if (this.readable.locked || this.writable.locked) {
      throw new DOMException('Cannot close while the streams are locked.', 'InvalidStateError');
    }
    this.readable = null;
    this.writable = null;
  }

  /** SerialPort.setSignals(); the C62 ignores DTR and RTS. */
  async setSignals(): Promise<void> {}

  /** Feeds host bytes through the SLIP decoder. */
  private async receive(bytes: Uint8Array): Promise<void> {
    for (const b of bytes) {
      if (b === END) {
        if (this.frame && this.frame.length > 0) await this.handle(Uint8Array.from(this.frame));
        this.frame = [];
      } else if (this.frame) {
        if (this.escaped) {
          this.frame.push(b === ESC_END ? END : ESC);
          this.escaped = false;
        } else if (b === ESC) {
          this.escaped = true;
        } else {
          this.frame.push(b);
        }
      }
    }
  }

  /** Queues a response: 8-byte header, two status bytes, optional payload. */
  private reply(op: number, value = 0, payload: Uint8Array = new Uint8Array(0)): void {
    const body = new Uint8Array(10 + payload.length);
    const view = new DataView(body.buffer);
    body[0] = 1;
    body[1] = op;
    view.setUint16(2, 2 + payload.length, true);
    view.setUint32(4, value, true);
    body.set(payload, 10);
    // Answer on a later tick, as a real chip would.
    setTimeout(() => {
      this.rx.push(...slipEncode(body));
      this.notify?.();
    }, this.options.replyDelayMs ?? 0);
  }

  /** Records `name` in the run-length encoded trace. */
  private record(name: string): void {
    const last = this.trace[this.trace.length - 1];
    const [lastName, count] = last?.split(' x') ?? [];
    if (lastName === name) this.trace[this.trace.length - 1] = `${name} x${Number(count) + 1}`;
    else this.trace.push(`${name} x1`);
  }

  /** Executes one request frame. */
  private async handle(frame: Uint8Array): Promise<void> {
    if (this.options.silent || frame.length < 8 || frame[0] !== 0) return;
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const op = frame[1];
    const size = view.getUint16(2, true);
    if (frame.length < 8 + size) return;
    const data = frame.subarray(8, 8 + size);
    const u32 = (i: number) => new DataView(data.buffer, data.byteOffset).getUint32(i * 4, true);
    this.record(NAMES[op] ?? `OP_${op.toString(16)}`);

    switch (op) {
      case 0x07: // MEM_DATA: size, seq, 0, 0, data
        this.ram.push(...data.subarray(16, 16 + u32(0)));
        return this.reply(op);
      case 0x02: // FLASH_BEGIN: size, blocks, block size, offset
        this.flashBlock = u32(2);
        this.flashBase = u32(3);
        return this.reply(op);
      case 0x03: {
        // FLASH_DATA: size, seq, 0, 0, data; checksum is XOR of data seeded with 0xEF.
        const chunk = data.subarray(16, 16 + u32(0));
        const sum = chunk.reduce((x, b) => x ^ b, 0xef);
        if (sum !== view.getUint32(4, true)) return;
        const at = this.flashBase + u32(1) * this.flashBlock;
        if (at + chunk.length > this.flash.length) return;
        this.flash.set(chunk, at);
        if (
          this.options.corruptAt !== undefined &&
          this.options.corruptAt >= at &&
          this.options.corruptAt < at + chunk.length
        ) {
          this.flash[this.options.corruptAt] ^= 0xff;
        }
        return this.reply(op);
      }
      case 0xd1: // ERASE_REGION: address, size
        this.flash.fill(0xff, u32(0), u32(0) + u32(1));
        return this.reply(op);
      case 0xf3: // FLASH_ID: capacity byte 0x16 = 4 MiB
        return this.reply(op, 0x1640c8);
      case 0xf4:
        return this.reply(op, 0, Uint8Array.from([0xc6, 0x20, 0x24, 0x09, 0x00, 0x06, 0x57, 0x01]));
      case 0x13: // MD5: address, size
        return this.reply(op, 0, await this.options.md5(this.flash.subarray(u32(0), u32(0) + u32(1))));
      case 0x0e: {
        // READ_FLASH: address, size
        const bytes = this.flash.slice(u32(0), u32(0) + u32(1));
        if (this.options.corruptReads && bytes.length > 0) bytes[0] ^= 0xff;
        return this.reply(op, 0, bytes);
      }
      default:
        return this.reply(op);
    }
  }
}
