// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Flasher for LISTENAI CSK6 radios (Retevis C62 / C2) over Web Serial.
 *
 * The protocol is not reimplemented here: this runs LISTENAI's cskburn (Apache-2.0)
 * compiled to WebAssembly (tools/cskburn-wasm) and gives it a serial port. cskburn
 * uploads its RAM burner, writes each partition and checks it with an MD5 the chip
 * computes over its own flash.
 */
import { FlashError, type FlashContext, type Segment } from './types.ts';

/** The serial calls tools/cskburn-wasm/serial_web.c makes on `Module.cskSerial`. */
interface CskSerial {
  open(path: string): Promise<number>;
  close(): Promise<void>;
  setBaud(baud: number): Promise<number>;
  setSignal(name: 'dataTerminalReady' | 'requestToSend', active: boolean): Promise<number>;
  discardInput(): void;
  read(count: number, timeoutMs: number): Promise<Uint8Array>;
  write(bytes: Uint8Array): Promise<void>;
}

/** The parts of the Emscripten module this file uses. */
interface CskModule {
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
  };
  callMain(args: string[]): void;
  onExit?: (code: number) => void;
  /** Ends a run at once, where the module can: one that runs a real program ends it. */
  stop?: () => void;
}

/** Loads the Emscripten factory; injected so tests can import it from disk. */
export type CskModuleLoader = () => Promise<(options: Record<string, unknown>) => Promise<unknown>>;

/** Options for a cskburn run. */
export interface CskOptions {
  /** Where the cskburn module comes from. */
  loadModule: CskModuleLoader;
  /** Burn baud rate; the boot ROM always starts at 115200. */
  baud?: number;
}

/**
 * The read errors Web Serial does not count as fatal: bytes were lost or damaged, and the
 * port goes on working with a new `readable`.
 */
const NON_FATAL_READ_ERRORS = new Set(['BufferOverrunError', 'BreakError', 'FramingError', 'ParityError']);

/**
 * Adapts a Web Serial port to the blocking-style calls cskburn makes. None of them ever
 * rejects: a rejection would leave cskburn waiting for an answer for ever. When the port
 * fails, `onFailure` is told and cskburn is cut off from the radio.
 */
class WebSerialAdapter implements CskSerial {
  private rx: number[] = [];
  private wake: (() => void) | null = null;
  private baud = 0;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private pump: Promise<void> = Promise.resolve();
  /** Set when the run was stopped: from then on cskburn talks to nothing and gives up. */
  private dead = false;
  /** Why the run cannot go on, once the port could not be opened or stopped taking data. */
  failure: FlashError | null = null;
  /** Told of `failure` when it happens. */
  onFailure: (() => void) | null = null;

  constructor(private readonly port: SerialPort) {}

  /** Opens at the boot ROM's 115200 baud. */
  open(): Promise<number> {
    return this.reopen(115200);
  }

  /** Cuts cskburn off from the radio and closes the port. Nothing more is sent. */
  async stop(): Promise<void> {
    this.dead = true;
    this.wake?.();
    await this.close();
  }

  /** The port failed: cuts cskburn off and reports why, in words for the person. */
  private fail(what: string, e: unknown): void {
    if (this.dead) return;
    this.dead = true;
    this.wake?.();
    this.failure = new FlashError(`${what}: ${e instanceof Error ? e.message : String(e)}`);
    this.onFailure?.();
  }

  /** (Re)opens the port; Web Serial cannot change baud on an open port. 0, or -1 when it would not open. */
  private async reopen(baud: number): Promise<number> {
    if (this.dead) return 0;
    await this.close();
    try {
      await this.port.open({ baudRate: baud, bufferSize: 64 * 1024 });
    } catch (e) {
      this.fail('The serial port could not be opened', e);
      return -1;
    }
    this.baud = baud;
    this.writer = this.port.writable!.getWriter();
    this.reader = this.port.readable!.getReader();
    this.pump = (async () => {
      for (;;) {
        try {
          const { value, done } = await this.reader!.read();
          // The stream ended: close() cancelled it.
          if (done) break;
          for (const b of value) this.rx.push(b);
          this.wake?.();
        } catch (e) {
          // close() is waiting for this loop to end.
          if (!this.baud) break;
          // After an error the port can recover from, Web Serial offers a new stream to
          // read on with. Any other error means the port is gone.
          const recovers = e instanceof Error && NON_FATAL_READ_ERRORS.has(e.name);
          const next = recovers ? this.port.readable : null;
          if (!next) {
            this.fail('The connection to the radio was lost', e);
            break;
          }
          this.reader!.releaseLock();
          this.reader = next.getReader();
        }
      }
    })();
    return 0;
  }

  /** Stops the reader and closes the port; safe to call twice. A port that is gone is closed already. */
  async close(): Promise<void> {
    if (!this.baud) return;
    this.baud = 0;
    await this.reader!.cancel().catch(() => {});
    await this.pump;
    this.reader!.releaseLock();
    this.writer!.releaseLock();
    await this.port.close().catch(() => {});
  }

  /** Changes baud by reopening the port. */
  async setBaud(baud: number): Promise<number> {
    return baud === this.baud ? 0 : this.reopen(baud);
  }

  /** Sets DTR or RTS; adapters without those lines are fine (C62 is entered by hand). */
  async setSignal(name: 'dataTerminalReady' | 'requestToSend', active: boolean): Promise<number> {
    await this.port.setSignals({ [name]: active }).catch(() => {});
    return 0;
  }

  /** Drops bytes received so far. */
  discardInput(): void {
    this.rx.length = 0;
  }

  /** Resolves with up to `count` bytes as soon as any arrive, or none after the timeout. */
  async read(count: number, timeoutMs: number): Promise<Uint8Array> {
    if (this.dead) return new Uint8Array(0);
    if (this.rx.length === 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
    return Uint8Array.from(this.rx.splice(0, count));
  }

  /** Writes and waits until the port accepted the bytes. */
  async write(bytes: Uint8Array): Promise<void> {
    if (this.dead) return;
    try {
      await this.writer!.write(bytes);
    } catch (e) {
      this.fail('The connection to the radio was lost', e);
    }
  }
}

/** Result of one cskburn run. */
interface CskRun {
  code: number;
  lines: string[];
  fs: CskModule['FS'];
  /** True when the run was stopped on purpose before cskburn finished. */
  stopped?: boolean;
}

/**
 * Runs one cskburn command line against `port` in a fresh module instance.
 * `onLine` gets every output line, including the `\r`-terminated progress lines. When
 * it returns true the run is stopped there: the port is closed and cskburn, cut off from
 * the radio, is left to give up by itself. A port that cannot be opened or stops taking
 * data ends the run the same way, with a FlashError.
 */
async function runCskburn(
  port: SerialPort,
  args: string[],
  files: Record<string, Uint8Array>,
  onLine: (line: string) => boolean | void,
  options: CskOptions,
): Promise<CskRun> {
  const adapter = new WebSerialAdapter(port);
  const lines: string[] = [];
  let pending = '';
  let cut = false;
  const emit = (code: number | null) => {
    // Cut off from the radio, cskburn goes on to report errors that mean nothing.
    if (cut) return;
    // cskburn redraws its progress line with '\r'; treat that as a line end too.
    if (code === null || code === 10 || code === 13) {
      if (pending.trim()) {
        lines.push(pending);
        if (onLine(pending) === true) {
          cut = true;
          stop();
        }
      }
      pending = '';
    } else {
      pending += String.fromCharCode(code);
    }
  };
  let stop: () => void = () => undefined;
  const stopped = new Promise<'stopped'>((resolve) => {
    stop = () => resolve('stopped');
  });
  const broken = new Promise<'broken'>((resolve) => {
    adapter.onFailure = () => resolve('broken');
  });
  const factory = await options.loadModule();
  const mod = (await factory({ cskSerial: adapter, stdout: emit, stderr: emit })) as CskModule;
  for (const [path, data] of Object.entries(files)) mod.FS.writeFile(path, data);
  const exited = new Promise<number>((resolve) => {
    mod.onExit = resolve;
  });
  try {
    // The C62 has no reset wiring, so retrying the reset is pointless: probe once and
    // fail quickly when the radio is not in flashing mode.
    const probe = ['--probe-timeout', '4000', '--reset-attempts', '0'];
    mod.callMain(['-C', '6', '-s', 'webserial', '-b', String(options.baud ?? 115200), ...probe, ...args]);
    const code = await Promise.race([exited, stopped, broken]);
    if (adapter.failure) {
      // What cskburn goes on to say about a port it has lost helps nobody.
      cut = true;
      mod.stop?.();
      await adapter.stop();
      throw adapter.failure;
    }
    if (code === 'stopped' || code === 'broken') {
      mod.stop?.();
      await adapter.stop();
      return { code: 0, lines, fs: mod.FS, stopped: true };
    }
    emit(null);
    return { code, lines, fs: mod.FS };
  } finally {
    await adapter.close().catch(() => {});
  }
}

/**
 * True when the run did what it was asked. cskburn can report an error (a failed
 * verification, for one) and still exit with code 0, so its output is checked as well.
 */
function succeeded(run: CskRun): boolean {
  return run.code === 0 && !run.lines.some((l) => /^ERROR\b/.test(l));
}

/** Turns a failed run into an error a person can act on. */
function failure(run: CskRun): FlashError {
  if (run.lines.some((l) => /E8003|MD5 does not match/i.test(l))) {
    return new FlashError(
      'What was read does not match the checksum the radio computed itself, so the data cannot be trusted. ' +
        'Check the cable and try again.',
    );
  }
  if (run.lines.some((l) => /E4001|did not respond|probe|no sync/i.test(l))) {
    return new FlashError(
      'The radio did not answer. Put it in flashing mode (off, hold the secondary PTT, power on, release) and try again.',
    );
  }
  const tail = run.lines.filter((l) => /error|fail|timeout|not /i.test(l)).slice(-2);
  return new FlashError(tail.join(' ') || `cskburn exited with code ${run.code}`);
}

/** Reads the chip's 8-byte eFuse ID as a hex string. Radio must be in flashing mode. */
export async function readCskChipId(
  port: SerialPort,
  ctx: FlashContext,
  options: CskOptions,
): Promise<string> {
  const run = await runCskburn(port, ['--chip-id'], {}, (line) => ctx.log(line), options);
  const id = run.lines.map((l) => /chip-id:\s*([0-9A-Fa-f]+)/.exec(l)?.[1]).find(Boolean);
  if (!succeeded(run) || !id) throw failure(run);
  return id;
}

/**
 * Throws when two segments would be written over the same flash. cskburn writes them one
 * after the other and checks each as it goes, so the later one would replace part of the
 * earlier one and the run would still end as a success.
 */
function refuseOverlap(segments: Segment[]): void {
  const sorted = [...segments].sort((a, b) => a.address - b.address);
  for (let i = 1; i < sorted.length; i++) {
    const before = sorted[i - 1];
    if (before.address + before.data.length > sorted[i].address) {
      throw new FlashError(
        `The image written at 0x${before.address.toString(16)} (${before.data.length} bytes) runs into ` +
          `the one written at 0x${sorted[i].address.toString(16)}. Nothing was sent to the radio.`,
      );
    }
  }
}

/**
 * Writes each segment (app at 0x0, DSP image at 0x100000) and has the chip verify it.
 * Segments that overlap are refused before anything is sent.
 * The radio must already be in flashing mode: off, hold the secondary PTT, power on, release.
 */
export async function flashCsk(
  port: SerialPort,
  segments: Segment[],
  ctx: FlashContext,
  options: CskOptions,
): Promise<void> {
  refuseOverlap(segments);
  const total = segments.reduce((n, s) => n + s.data.length, 0);
  const files: Record<string, Uint8Array> = {};
  const args = ['--verify-all'];
  segments.forEach((s, i) => {
    files[`/part${i}.bin`] = s.data;
    args.push(`0x${s.address.toString(16)}`, `/part${i}.bin`);
  });

  let part = -1;
  let before = 0;
  const onLine = (line: string) => {
    const progress = /^\s*([\d.]+) KB \/ ([\d.]+) KB/.exec(line);
    if (progress) {
      const done =
        before + Math.min(Math.round(Number(progress[1]) * 1024), segments[part]?.data.length ?? 0);
      ctx.progress({ phase: 'write', done, total });
      return;
    }
    if (line.startsWith('Burning partition')) {
      if (part >= 0) before += segments[part].data.length;
      part++;
    }
    ctx.log(line);
  };

  ctx.progress({ phase: 'connect', done: 0, total });
  const run = await runCskburn(port, args, files, onLine, options);
  if (!succeeded(run) || !run.lines.some((l) => l.startsWith('Finished'))) throw failure(run);
  ctx.progress({ phase: 'done', done: total, total });
}

/**
 * Reads `size` bytes of flash starting at `address` (4 MiB from 0x0 is the whole chip).
 * The page uses it to back the radio up before the first flash.
 */
export async function readCsk(
  port: SerialPort,
  address: number,
  size: number,
  ctx: FlashContext,
  options: CskOptions,
): Promise<Uint8Array> {
  const spec = `0x${address.toString(16)}:0x${size.toString(16)}:/read.bin`;
  const onLine = (line: string) => {
    const progress = /^\s*([\d.]+) KB \/ ([\d.]+) KB/.exec(line);
    if (progress) {
      ctx.progress({
        phase: 'read',
        done: Math.min(Math.round(Number(progress[1]) * 1024), size),
        total: size,
      });
    } else {
      ctx.log(line);
    }
  };
  ctx.progress({ phase: 'connect', done: 0, total: size });
  // --verify-all makes cskburn compare what it read with an MD5 the chip computes itself.
  const run = await runCskburn(port, ['--verify-all', '--read', spec], {}, onLine, options);
  if (!succeeded(run)) throw failure(run);
  const data = run.fs.readFile('/read.bin');
  if (data.length !== size) throw new FlashError(`Read ${data.length} of ${size} bytes from the radio.`);
  ctx.progress({ phase: 'read', done: size, total: size });
  return data;
}

/**
 * Reads `size` bytes of flash from the start, like `readCsk`, and the chip's ID in the
 * same flashing-mode session, so a backup knows which radio it came from. `known` is asked
 * as soon as the chip has given its ID; when it says the radio is already backed up, the
 * run stops before any flash is read.
 */
export async function backupCsk(
  port: SerialPort,
  size: number,
  ctx: FlashContext,
  options: CskOptions,
): Promise<{ data: Uint8Array; chipId: string | null }>;
export async function backupCsk(
  port: SerialPort,
  size: number,
  ctx: FlashContext,
  options: CskOptions,
  known: ((chipId: string) => boolean) | undefined,
): Promise<{ data: Uint8Array; chipId: string | null } | { known: string }>;
export async function backupCsk(
  port: SerialPort,
  size: number,
  ctx: FlashContext,
  options: CskOptions,
  known?: (chipId: string) => boolean,
): Promise<{ data: Uint8Array; chipId: string | null } | { known: string }> {
  const spec = `0x0:0x${size.toString(16)}:/read.bin`;
  let chipId: string | null = null;
  let recognised = false;
  const onLine = (line: string): boolean => {
    const progress = /^\s*([\d.]+) KB \/ ([\d.]+) KB/.exec(line);
    if (progress) {
      ctx.progress({
        phase: 'read',
        done: Math.min(Math.round(Number(progress[1]) * 1024), size),
        total: size,
      });
      return false;
    }
    ctx.log(line);
    const id = /chip-id:\s*([0-9A-Fa-f]+)/.exec(line)?.[1];
    if (id && chipId === null) {
      chipId = id;
      if (known?.(id)) {
        ctx.log('This radio already has a backup; not reading it again.');
        recognised = true;
        return true;
      }
    }
    return false;
  };
  ctx.progress({ phase: 'connect', done: 0, total: size });
  // --verify-all makes cskburn compare what it read with an MD5 the chip computes itself.
  const run = await runCskburn(port, ['--chip-id', '--verify-all', '--read', spec], {}, onLine, options);
  if (recognised && chipId !== null) return { known: chipId };
  if (!succeeded(run)) throw failure(run);
  const data = run.fs.readFile('/read.bin');
  if (data.length !== size) throw new FlashError(`Read ${data.length} of ${size} bytes from the radio.`);
  ctx.progress({ phase: 'read', done: size, total: size });
  return { data, chipId };
}
