// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A serial port for as long as one flash or one read lasts, and reading from it with a
 * time limit. Shared by the flashers and readers that speak over Web Serial themselves
 * (the C62's cskburn brings its own serial layer).
 */
import { FlashError, messageOf } from './types.ts';

/** Reads with a timeout over a stream reader: a byte at a time, or a buffer full. */
export class SerialReader {
  private chunk: Uint8Array = new Uint8Array(0);
  private at = 0;
  /** A read that outlived its timeout; the next call picks it up, so no bytes are lost. */
  private pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;

  /**
   * Wraps `reader`; the caller keeps ownership of the lock. `closed` is the error when
   * the port goes away in the middle.
   */
  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly closed = 'The serial port closed while talking to the radio.',
  ) {}

  /** Waits for input when none is buffered; false when none arrives within `timeoutMs`. */
  private async fill(timeoutMs: number): Promise<boolean> {
    while (this.at >= this.chunk.length) {
      this.pending ??= this.reader.read();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      });
      const result = await Promise.race([this.pending, timeout]);
      clearTimeout(timer);
      if (result === null) return false;
      this.pending = null;
      if (result.done) throw new FlashError(this.closed);
      this.chunk = result.value;
      this.at = 0;
    }
    return true;
  }

  /** Returns the next byte, or null when none arrives within `timeoutMs`. */
  async readByte(timeoutMs: number): Promise<number | null> {
    if (!(await this.fill(timeoutMs))) return null;
    return this.chunk[this.at++];
  }

  /**
   * Fills `out` from offset `from`; returns how many bytes of `out` are filled when
   * the radio stops sending for `timeoutMs`.
   */
  async read(out: Uint8Array, from: number, timeoutMs: number): Promise<number> {
    let got = from;
    while (got < out.length) {
      if (!(await this.fill(timeoutMs))) break;
      const take = Math.min(out.length - got, this.chunk.length - this.at);
      out.set(this.chunk.subarray(this.at, this.at + take), got);
      this.at += take;
      got += take;
    }
    return got;
  }

  /**
   * Discards input until the line has been quiet for `quietMs`, or `limit` bytes went by.
   * Never takes more than `limit` bytes.
   */
  async drain(quietMs: number, limit: number): Promise<number> {
    let dropped = 0;
    while (dropped < limit && (await this.readByte(quietMs)) !== null) dropped++;
    return dropped;
  }

  /**
   * Discards input as `drain` does, but whatever arrived together goes together: the
   * last piece may take it past `limit`. For clearing out what is left of a broken answer.
   */
  async drainChunks(quietMs: number, limit: number): Promise<number> {
    let dropped = 0;
    while (dropped < limit && (await this.fill(quietMs))) {
      dropped += this.chunk.length - this.at;
      this.at = this.chunk.length;
    }
    return dropped;
  }
}

/** How `withSerial` opens the port. */
export interface SerialSession {
  /** Serial speed; always 8 data bits, no parity, 1 stop bit, no flow control. */
  baudRate: number;
  /** The error when the port goes away in the middle, where the usual words do not fit. */
  closed?: string;
}

/**
 * Opens `port`, runs `use` with its input and output, and closes it again whatever
 * happens. Takes a closed port. Throws FlashError when the port cannot be opened or has
 * no streams; anything `use` throws is passed on once the port is closed.
 */
export async function withSerial<T>(
  port: SerialPort,
  options: SerialSession,
  use: (input: SerialReader, output: WritableStreamDefaultWriter<Uint8Array>) => Promise<T>,
): Promise<T> {
  try {
    await port.open({
      baudRate: options.baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
    });
  } catch (e) {
    throw new FlashError(`Could not open the serial port: ${messageOf(e)}`);
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  try {
    if (!port.readable || !port.writable) throw new FlashError('The serial port has no data streams.');
    reader = port.readable.getReader();
    writer = port.writable.getWriter();
    return await use(new SerialReader(reader, options.closed), writer);
  } finally {
    // Chrome refuses to close a port whose streams are locked. Cancelling also ends a
    // read that is still waiting.
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    writer?.releaseLock();
    await port.close().catch(() => {});
  }
}
