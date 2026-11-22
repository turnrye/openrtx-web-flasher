// SPDX-License-Identifier: GPL-3.0-or-later
/** Reading a serial port a byte at a time, shared by the serial flashers. */
import { FlashError } from './types.ts';

/** Byte-at-a-time reads with a timeout over a stream reader. */
export class ByteReader {
  private buffer: number[] = [];
  /** A read that outlived its timeout; the next call picks it up, so no bytes are lost. */
  private pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;

  /** Wraps `reader`; the caller keeps ownership of the lock. */
  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  /** Returns the next byte, or null when none arrives within `timeoutMs`. */
  async readByte(timeoutMs: number): Promise<number | null> {
    while (this.buffer.length === 0) {
      this.pending ??= this.reader.read();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      });
      const result = await Promise.race([this.pending, timeout]);
      clearTimeout(timer);
      if (result === null) return null;
      this.pending = null;
      if (result.done) throw new FlashError('The serial port closed while talking to the radio.');
      for (const b of result.value) this.buffer.push(b);
    }
    return this.buffer.shift() ?? null;
  }

  /** Discards input until the line has been quiet for `quietMs`, or `limit` bytes went by. */
  async drain(quietMs: number, limit: number): Promise<number> {
    let dropped = 0;
    while (dropped < limit && (await this.readByte(quietMs)) !== null) dropped++;
    return dropped;
  }
}
