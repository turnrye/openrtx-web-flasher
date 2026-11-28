// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Stand-ins for the tests of the command line: a terminal that records, the three
 * native packages wired to the simulated radios in src/sim, and a program that plays
 * cskburn. No test touches a real device.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Io } from './io.ts';
import type { HidModule, NativeHid } from './node-hid.ts';
import type { NativePort, PortInfo, SerialModule } from './node-serial.ts';

const made: string[] = [];

/** A new empty folder for a test. `removeFolders` clears them all away. */
export function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ortx-cli-test-'));
  made.push(dir);
  return dir;
}

/** Removes every folder `folder` made; for a test file's `afterAll`. */
export function removeFolders(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A terminal that keeps what was said and answers from a script. */
export interface FakeIo extends Io {
  /** Every line said, oldest first. */
  lines: string[];
  /** Every question asked, oldest first. */
  asked: string[];
  /** Everything said, as one text. */
  text(): string;
}

/**
 * A terminal for tests. `answers` are given to the questions in order: a boolean to a
 * yes/no question, a number to a choice. With none it is not interactive.
 */
export function fakeIo(answers?: (boolean | number | null)[]): FakeIo {
  const lines: string[] = [];
  const asked: string[] = [];
  const left = [...(answers ?? [])];
  return {
    interactive: answers !== undefined,
    lines,
    asked,
    text: () => lines.join('\n'),
    say: (line = '') => void lines.push(line),
    progress: () => {},
    confirm: (question) => {
      asked.push(question);
      return Promise.resolve(left.shift() === true);
    },
    choose: (question, options) => {
      asked.push(`${question} ${options.join(' | ')}`);
      const answer = left.shift();
      return Promise.resolve(typeof answer === 'number' ? answer : null);
    },
  };
}

/** A fake `serialport` package and what was done with it. */
export interface FakeSerial extends SerialModule {
  /** The options of every port constructed, oldest first. */
  constructed: { path: string; baudRate: number }[];
  /** DTR and RTS as last set. */
  signals: { dtr?: boolean; rts?: boolean }[];
}

/**
 * A `serialport` package whose every port is the Web Serial shaped `device`: one of the
 * simulated radios. `ports` is what list() reports.
 */
export function serialOver(device: SerialPort, ports: PortInfo[] = [{ path: '/dev/fake' }]): FakeSerial {
  const constructed: FakeSerial['constructed'] = [];
  const signals: FakeSerial['signals'] = [];

  /** One port of the fake package. */
  class Port implements NativePort {
    private data: ((data: Uint8Array) => void)[] = [];
    private closed: (() => void)[] = [];
    private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
    private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    /** Remembers how the port was asked for. */
    constructor(private readonly options: { path: string; baudRate: number }) {
      constructed.push({ path: options.path, baudRate: options.baudRate });
    }

    /** Opens the simulated radio and starts passing on what it sends. */
    open(done: (error?: Error | null) => void): void {
      device.open({ baudRate: this.options.baudRate }).then(() => {
        this.writer = device.writable!.getWriter();
        const reader = device.readable!.getReader();
        this.reader = reader;
        void (async () => {
          for (;;) {
            const { value, done: ended } = await reader.read();
            if (ended) break;
            // One shared buffer, as serialport reuses its own: a listener must copy.
            const shared = Buffer.from(value);
            this.data.forEach((listener) => listener(shared));
            shared.fill(0);
          }
        })();
        done(null);
      }, done);
    }

    /** Closes the simulated radio. */
    close(done: (error?: Error | null) => void): void {
      void (async () => {
        await this.reader?.cancel();
        this.reader?.releaseLock();
        this.writer?.releaseLock();
        await device.close();
        this.closed.forEach((listener) => listener());
      })().then(() => done(null), done);
    }

    /** Hands bytes to the simulated radio. */
    write(data: Uint8Array, done: (error?: Error | null) => void): void {
      this.writer!.write(Uint8Array.from(data)).then(() => done(null), done);
    }

    /** Nothing is buffered. */
    drain(done: (error?: Error | null) => void): void {
      done(null);
    }

    /** Records DTR and RTS. */
    set(wanted: { dtr?: boolean; rts?: boolean }, done: (error?: Error | null) => void): void {
      signals.push(wanted);
      done(null);
    }

    /** Registers a listener. */
    on(event: string, listener: never): unknown {
      if (event === 'data') this.data.push(listener);
      if (event === 'close') this.closed.push(listener);
      return this;
    }
  }

  return { constructed, signals, SerialPort: Object.assign(Port, { list: () => Promise.resolve(ports) }) };
}

/** A `node-hid` package whose one device is the WebHID shaped `device`: a simulated radio. */
export function hidOver(device: HIDDevice): HidModule {
  return {
    devicesAsync: () =>
      Promise.resolve([
        { vendorId: 0x1234, productId: 0x5678, path: 'other', product: 'Some keyboard' },
        { vendorId: device.vendorId, productId: device.productId, path: 'radio', product: 'Radio' },
        // Listed without a path: cannot be opened, so it must be passed over.
        { vendorId: device.vendorId, productId: device.productId },
      ]),
    HIDAsync: {
      open: async (path) => {
        if (path !== 'radio') throw new Error(`cannot open ${path}`);
        await device.open();
        const native: NativeHid = {
          on: (event: string, listener: never) => {
            if (event !== 'data') return native;
            // hidapi gives the report ID as the first byte of a numbered report.
            device.addEventListener('inputreport', (e) => {
              const bytes = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
              (listener as (data: Uint8Array) => void)(Buffer.from([e.reportId, ...bytes]));
            });
            return native;
          },
          write: async (data) => {
            await device.sendReport(data[0], Uint8Array.from(data.subarray(1)));
            return data.length;
          },
          close: () => device.close(),
        };
        return native;
      },
    },
  };
}

/** What the stand-in cskburn wrote down about one run. */
export interface CskburnRecord {
  args: string[];
  /** SHA-256 of each image it was told to write, by the address it goes to. */
  parts: Record<string, string>;
}

/** The chip ID the stand-in cskburn reports. */
export const STAND_IN_CHIP_ID = '0123456789ABCDEF';

/**
 * Writes a program into `dir` that plays cskburn: it prints what cskburn prints for a
 * write or a read, writes the file a read asks for, and records its arguments and the
 * images it was given in `dir`/record.json. Asked to read and to write, it reads first,
 * as cskburn does, and takes a moment over it. With `silent` it plays a radio that is not
 * in flashing mode. With `slow` it takes a minute over a read after giving the chip ID.
 * It leaves its process ID in `dir`/pid and the folder it runs in in `dir`/cwd. Returns
 * the program's path.
 */
export function standInCskburn(dir: string, silent = false, slow = false): string {
  const path = join(dir, 'cskburn');
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require('node:fs');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
const record = { args, parts: {} };
const save = () => fs.writeFileSync(${JSON.stringify(join(dir, 'record.json'))}, JSON.stringify(record));
const say = (line) => process.stdout.write(line + '\\n');
if (${JSON.stringify(silent)}) {
  process.stderr.write('ERROR [E4001]: Failed entering update mode: device did not respond\\n');
  save();
  process.exit(1);
}
fs.writeFileSync(${JSON.stringify(join(dir, 'pid'))}, String(process.pid));
fs.writeFileSync(${JSON.stringify(join(dir, 'cwd'))}, process.cwd());
say('Entering update mode...');
if (args.includes('--chip-id')) say('chip-id: ${STAND_IN_CHIP_ID}');
const read = args.indexOf('--read');
const images = [];
for (let i = 0; i < args.length - 1; i++) {
  if (/^0x[0-9a-f]+$/i.test(args[i]) && fs.existsSync(args[i + 1])) images.push([args[i], args[i + 1]]);
}
const burn = () => {
  images.forEach(([address, file], i) => {
    const data = fs.readFileSync(file);
    record.parts[address] = crypto.createHash('sha256').update(data).digest('hex');
    const kb = (data.length / 1024).toFixed(2);
    say('Burning partition ' + (i + 1) + '/' + images.length + '... (' + address + ', ' + kb + ' KB)');
    say(kb + ' KB / ' + kb + ' KB (100.00%)');
  });
  say('Finished');
  save();
};
if (${JSON.stringify(slow)} && read >= 0) {
  setTimeout(() => process.exit(0), 60000);
} else if (read >= 0) {
  const [, size, file] = args[read + 1].split(':');
  const data = Buffer.alloc(Number(size));
  for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 0xff;
  fs.writeFileSync(file, data);
  const kb = (data.length / 1024).toFixed(2);
  say('Reading region...');
  say(kb + ' KB / ' + kb + ' KB (100.00%)');
  // A read takes its time on a radio; whoever ended the run meanwhile sees nothing written.
  setTimeout(burn, images.length > 0 ? 500 : 0);
} else {
  burn();
}
`,
  );
  chmodSync(path, 0o755);
  return path;
}
