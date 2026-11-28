// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { FakeSerialPort } from '../sim/serial.ts';
import { SerialReader, withSerial } from './serial.ts';
import { FlashError } from './types.ts';

/** A reader over `chunks`, which then stays silent, or closes when `end` is set. */
function readerOf(chunks: number[][], end = false): ReadableStreamDefaultReader<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
      if (end) controller.close();
    },
  }).getReader();
}

/** A port that answers every write with the same bytes. */
class EchoPort extends FakeSerialPort {
  /** Sends back what was written. */
  protected onData(bytes: Uint8Array): void {
    this.respond(bytes);
  }
}

describe('SerialReader', () => {
  it('reads a byte at a time across chunks and gives null when the line goes quiet', async () => {
    const input = new SerialReader(readerOf([[1, 2], [], [3]]));
    expect(await input.readByte(50)).toBe(1);
    expect(await input.readByte(50)).toBe(2);
    expect(await input.readByte(50)).toBe(3);
    expect(await input.readByte(5)).toBeNull();
  });

  it('fills a buffer from an offset and says how far it got', async () => {
    const input = new SerialReader(
      readerOf([
        [1, 2, 3],
        [4, 5],
      ]),
    );
    const out = new Uint8Array(4);
    expect(await input.read(out.subarray(0, 1), 0, 50)).toBe(1);
    expect(await input.read(out, 1, 50)).toBe(4);
    expect([...out]).toEqual([1, 2, 3, 4]);
    // One byte is left; a longer read stops there when nothing more comes.
    expect(await input.read(new Uint8Array(3), 0, 5)).toBe(1);
  });

  it('drains to the byte, or by whole pieces', async () => {
    const exact = new SerialReader(readerOf([[1, 2, 3, 4, 5]]));
    expect(await exact.drain(5, 3)).toBe(3);
    expect(await exact.readByte(5)).toBe(4);

    const pieces = new SerialReader(readerOf([[1, 2, 3, 4, 5], [6]]));
    expect(await pieces.drainChunks(5, 3)).toBe(5);
    expect(await pieces.readByte(5)).toBe(6);
  });

  it('says in the caller’s words that the port closed', async () => {
    await expect(new SerialReader(readerOf([], true)).readByte(50)).rejects.toThrow(
      'The serial port closed while talking to the radio.',
    );
    const reading = new SerialReader(readerOf([], true), 'The serial port closed while reading the radio.');
    await expect(reading.read(new Uint8Array(1), 0, 50)).rejects.toThrow(
      'The serial port closed while reading the radio.',
    );
  });
});

describe('withSerial', () => {
  it('opens at 8N1, hands over input and output, and closes the port afterwards', async () => {
    const port = new EchoPort();
    const answer = await withSerial(port, { baudRate: 115200 }, async (input, output) => {
      await output.write(Uint8Array.of(0x42));
      return input.readByte(100);
    });
    expect(answer).toBe(0x42);
    expect(port.opens).toEqual([
      { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' },
    ]);
    expect(port.opened).toBe(false);
  });

  it('closes the port when the work fails, and passes the failure on', async () => {
    const port = new EchoPort();
    const work = withSerial(port, { baudRate: 9600 }, async (input) => {
      // A read is still waiting when the work gives up; closing the port ends it.
      input.readByte(10_000).catch(() => {});
      throw new FlashError('The radio said no.');
    });
    await expect(work).rejects.toThrow('The radio said no.');
    expect(port.opened).toBe(false);
  });

  it('puts a port that will not open into words', async () => {
    const port = new EchoPort();
    await port.open({ baudRate: 9600 });
    const work = withSerial(port, { baudRate: 9600 }, async () => 'not reached');
    await expect(work).rejects.toBeInstanceOf(FlashError);
    await expect(work).rejects.toThrow('Could not open the serial port: The port is already open.');
  });
});
