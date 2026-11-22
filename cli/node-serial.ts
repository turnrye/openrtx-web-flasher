// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A serial port of this computer in the shape of the browser's Web Serial port, so the
 * flashers and readers written for the page run unchanged. Built on the `serialport`
 * package, of which only the parts named here are used.
 */

/** One serial port as `serialport` lists it. */
export interface PortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
}

/** The part of an open port's binding that the macOS wake-up uses. */
export interface NativeBinding {
  poller?: {
    listenerCount(event: 'readable'): number;
    emit(event: 'readable', error: null): boolean;
  };
}

/** An open or openable port of the `serialport` package. */
export interface NativePort {
  /** The binding of the open port, where serialport's reads wait. */
  readonly port?: NativeBinding;
  open(done: (error?: Error | null) => void): void;
  close(done: (error?: Error | null) => void): void;
  write(data: Uint8Array, done: (error?: Error | null) => void): void;
  drain(done: (error?: Error | null) => void): void;
  set(signals: { dtr?: boolean; rts?: boolean }, done: (error?: Error | null) => void): void;
  on(event: 'data', listener: (data: Uint8Array) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
}

/** The part of the `serialport` package this file uses. */
export interface SerialModule {
  SerialPort: {
    new (options: {
      path: string;
      baudRate: number;
      dataBits?: number;
      stopBits?: number;
      parity?: string;
      rtscts?: boolean;
      autoOpen: false;
    }): NativePort;
    list(): Promise<PortInfo[]>;
  };
}

/** How often a waiting read is woken on macOS, in milliseconds (see wakeReads). */
const MACOS_WAKE_MS = 5;

/**
 * Wakes the read serialport waits on, if one is waiting. After a read finds nothing,
 * serialport waits for the system to report the port readable, and on macOS kqueue
 * never reports some adapters (a CH340 on Apple's own driver held an RT-950 Pro's
 * answer until the next write). A wake-up with nothing there reads nothing and waits
 * again.
 */
function wakeReads(binding: NativeBinding | undefined): void {
  const poller = binding?.poller;
  if (poller && poller.listenerCount('readable') > 0) poller.emit('readable', null);
}

/** Runs one callback-style call of `serialport` as a promise. */
function call(run: (done: (error?: Error | null) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => run((error) => (error ? reject(error) : resolve())));
}

/** Web Serial's SerialPort over a port of this computer. Cast it to `SerialPort` to hand it to a flasher. */
export class NodeSerialPort {
  private native: NativePort | null = null;
  private stream: ReadableStream<Uint8Array> | null = null;
  private sink: WritableStream<Uint8Array> | null = null;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  /** What arrived while no stream was there to take it. */
  private pending: Uint8Array[] = [];
  /** Wakes waiting reads while the port is open, where reads need it. */
  private waker: ReturnType<typeof setInterval> | null = null;

  /**
   * A closed port; `path` is its name on this computer (/dev/ttyUSB0, COM5). `wakeMs`
   * wakes waiting reads that often (wakeReads), by default on macOS only; 0 never.
   */
  constructor(
    private readonly serial: SerialModule,
    readonly path: string,
    private readonly wakeMs = process.platform === 'darwin' ? MACOS_WAKE_MS : 0,
  ) {}

  /** SerialPort.readable; null while closed. Like Chrome, a cancelled stream is replaced by a fresh one. */
  get readable(): ReadableStream<Uint8Array> | null {
    if (!this.native) return null;
    this.stream ??= new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
        for (const bytes of this.pending.splice(0)) controller.enqueue(bytes);
      },
      cancel: () => {
        this.controller = null;
        this.stream = null;
      },
    });
    return this.stream;
  }

  /** SerialPort.writable; null while closed. A write is done when the bytes left the computer. */
  get writable(): WritableStream<Uint8Array> | null {
    const native = this.native;
    if (!native) return null;
    this.sink ??= new WritableStream<Uint8Array>({
      write: async (chunk) => {
        await call((done) => native.write(Buffer.from(chunk), done));
        await call((done) => native.drain(done));
      },
    });
    return this.sink;
  }

  /** SerialPort.open(). */
  async open(options: SerialOptions): Promise<void> {
    if (this.native) throw new DOMException('The port is already open.', 'InvalidStateError');
    const native = new this.serial.SerialPort({
      path: this.path,
      baudRate: options.baudRate,
      dataBits: options.dataBits,
      stopBits: options.stopBits,
      parity: options.parity,
      rtscts: options.flowControl === 'hardware',
      autoOpen: false,
    });
    // Listen before opening, so nothing the radio sends first is lost. serialport reuses
    // its buffers, so every chunk is copied before it is queued.
    native.on('data', (data) => {
      const bytes = Uint8Array.from(data);
      if (this.controller) this.controller.enqueue(bytes);
      else this.pending.push(bytes);
    });
    // An unplugged cable ends the stream; the flashers say what that means.
    native.on('error', (error) => this.controller?.error(error));
    native.on('close', () => this.ended());
    await call((done) => native.open(done));
    this.native = native;
    if (this.wakeMs > 0) {
      this.waker = setInterval(() => wakeReads(native.port), this.wakeMs);
      this.waker.unref();
    }
  }

  /** Forgets the open port and ends its streams. */
  private ended(): void {
    if (this.waker) clearInterval(this.waker);
    this.waker = null;
    try {
      this.controller?.close();
    } catch {
      // Already closed or failed.
    }
    this.controller = null;
    this.stream = null;
    this.sink = null;
    this.pending = [];
    this.native = null;
  }

  /** SerialPort.close(); like Chrome, refuses while a reader or writer holds a lock. */
  async close(): Promise<void> {
    const native = this.native;
    if (!native) throw new DOMException('The port is already closed.', 'InvalidStateError');
    if (this.stream?.locked) throw new TypeError('Cannot cancel a locked stream');
    if (this.sink?.locked) throw new TypeError('Cannot abort a locked stream');
    this.ended();
    await call((done) => native.close(done));
  }

  /** SerialPort.setSignals(): DTR and RTS. */
  async setSignals(signals: SerialOutputSignals): Promise<void> {
    const native = this.native;
    if (!native) throw new DOMException('The port is closed.', 'InvalidStateError');
    const wanted = {
      ...(signals.dataTerminalReady === undefined ? {} : { dtr: signals.dataTerminalReady }),
      ...(signals.requestToSend === undefined ? {} : { rts: signals.requestToSend }),
    };
    await call((done) => native.set(wanted, done));
  }

  /** SerialPort.getInfo(); nothing is known about the adapter. */
  getInfo(): SerialPortInfo {
    return {};
  }
}
