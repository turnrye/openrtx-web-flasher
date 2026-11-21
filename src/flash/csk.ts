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

/** Adapts a Web Serial port to the blocking-style calls cskburn makes. */
class WebSerialAdapter implements CskSerial {
  private rx: number[] = [];
  private wake: (() => void) | null = null;
  private baud = 0;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private pump: Promise<void> = Promise.resolve();

  constructor(private readonly port: SerialPort) {}

  /** Opens at the boot ROM's 115200 baud. */
  async open(): Promise<number> {
    await this.reopen(115200);
    return 0;
  }

  /** (Re)opens the port; Web Serial cannot change baud on an open port. */
  private async reopen(baud: number): Promise<void> {
    await this.close();
    await this.port.open({ baudRate: baud, bufferSize: 64 * 1024 });
    this.baud = baud;
    this.writer = this.port.writable!.getWriter();
    const reader = this.port.readable!.getReader();
    this.reader = reader;
    this.pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const b of value) this.rx.push(b);
          this.wake?.();
        }
      } catch {
        // Port closed or adapter unplugged: reads just time out from here on.
      }
    })();
  }

  /** Stops the reader and closes the port; safe to call twice. */
  async close(): Promise<void> {
    if (!this.baud) return;
    await this.reader!.cancel().catch(() => {});
    await this.pump;
    this.reader!.releaseLock();
    this.writer!.releaseLock();
    await this.port.close();
    this.baud = 0;
  }

  /** Changes baud by reopening the port. */
  async setBaud(baud: number): Promise<number> {
    if (baud !== this.baud) await this.reopen(baud);
    return 0;
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
    await this.writer!.write(bytes);
  }
}

/** Result of one cskburn run. */
interface CskRun {
  code: number;
  lines: string[];
  fs: CskModule['FS'];
}

/**
 * Runs one cskburn command line against `port` in a fresh module instance.
 * `onLine` gets every output line, including the `\r`-terminated progress lines.
 */
async function runCskburn(
  port: SerialPort,
  args: string[],
  files: Record<string, Uint8Array>,
  onLine: (line: string) => void,
  options: CskOptions,
): Promise<CskRun> {
  const adapter = new WebSerialAdapter(port);
  const lines: string[] = [];
  let pending = '';
  const emit = (code: number | null) => {
    // cskburn redraws its progress line with '\r'; treat that as a line end too.
    if (code === null || code === 10 || code === 13) {
      if (pending.trim()) {
        lines.push(pending);
        onLine(pending);
      }
      pending = '';
    } else {
      pending += String.fromCharCode(code);
    }
  };
  const factory = await options.loadModule();
  const mod = (await factory({ cskSerial: adapter, stdout: emit, stderr: emit })) as CskModule;
  for (const [path, data] of Object.entries(files)) mod.FS.writeFile(path, data);
  const exited = new Promise<number>((resolve) => {
    mod.onExit = resolve;
  });
  try {
    // The C62 has no reset wiring, so retrying the reset is pointless: probe once and
    // fail quickly when the radio is not in burn mode.
    const probe = ['--probe-timeout', '4000', '--reset-attempts', '0'];
    mod.callMain(['-C', '6', '-s', 'webserial', '-b', String(options.baud ?? 115200), ...probe, ...args]);
    const code = await exited;
    emit(null);
    return { code, lines, fs: mod.FS };
  } finally {
    await adapter.close().catch(() => {});
  }
}

/** Turns cskburn's last error lines into one message. */
function failure(run: CskRun): FlashError {
  if (run.lines.some((l) => /E4001|did not respond|probe|no sync/i.test(l))) {
    return new FlashError(
      'The radio did not answer. Put it in burn mode (off, hold the secondary PTT, power on, release) and try again.',
    );
  }
  const tail = run.lines.filter((l) => /error|fail|timeout|not /i.test(l)).slice(-2);
  return new FlashError(tail.join(' ') || `cskburn exited with code ${run.code}`);
}

/** Reads the chip's 8-byte eFuse ID as a hex string. Radio must be in burn mode. */
export async function readCskChipId(port: SerialPort, ctx: FlashContext, options: CskOptions): Promise<string> {
  const run = await runCskburn(port, ['--chip-id'], {}, ctx.log, options);
  const id = run.lines.map((l) => /chip-id:\s*([0-9A-Fa-f]+)/.exec(l)?.[1]).find(Boolean);
  if (run.code !== 0 || !id) throw failure(run);
  return id;
}

/**
 * Writes each segment (app at 0x0, DSP image at 0x100000) and has the chip verify it.
 * The radio must already be in burn mode: off, hold the secondary PTT, power on, release.
 */
export async function flashCsk(
  port: SerialPort,
  segments: Segment[],
  ctx: FlashContext,
  options: CskOptions,
): Promise<void> {
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
      const done = before + Math.min(Math.round(Number(progress[1]) * 1024), segments[part]?.data.length ?? 0);
      ctx.progress({ phase: 'write', done, total });
      return;
    }
    if (/^Burning partition/.test(line)) {
      if (part >= 0) before += segments[part].data.length;
      part++;
    }
    ctx.log(line);
  };

  ctx.progress({ phase: 'connect', done: 0, total });
  const run = await runCskburn(port, args, files, onLine, options);
  if (run.code !== 0 || !run.lines.some((l) => /^Finished/.test(l))) throw failure(run);
  ctx.progress({ phase: 'done', done: total, total });
}

/**
 * Reads `size` bytes of flash starting at `address` (4 MiB from 0x0 is the whole chip).
 * Not wired into the page yet; this is the hook for backup-before-flash.
 */
export async function readCsk(
  port: SerialPort,
  address: number,
  size: number,
  ctx: FlashContext,
  options: CskOptions,
): Promise<Uint8Array> {
  const spec = `0x${address.toString(16)}:0x${size.toString(16)}:/read.bin`;
  const run = await runCskburn(port, ['--read', spec], {}, ctx.log, options);
  if (run.code !== 0) throw failure(run);
  return run.fs.readFile('/read.bin');
}
