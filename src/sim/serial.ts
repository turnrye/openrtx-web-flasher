// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Minimal fake Web Serial port for the simulators, built on WHATWG streams. It models
 * what a flasher relies on in Chrome: open() creates `readable` and `writable`, a
 * cancelled `readable` is replaced by a fresh one while the port stays open, and
 * close() fails while either stream is locked.
 */

/** Fake SerialPort; subclasses implement the device on the other end. */
export abstract class FakeSerialPort extends EventTarget implements SerialPort {
  onconnect: ((this: SerialPort, ev: Event) => void) | null = null;
  ondisconnect: ((this: SerialPort, ev: Event) => void) | null = null;
  readonly connected = true;
  /** Options of every open() call, oldest first. */
  readonly opens: SerialOptions[] = [];
  /** Signals of every setSignals() call, oldest first. */
  readonly signals: SerialOutputSignals[] = [];

  private isOpen = false;
  private readableStream: ReadableStream<Uint8Array> | null = null;
  private writableStream: WritableStream<Uint8Array> | null = null;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  /** Creates a closed port; `info` is what getInfo() returns. */
  constructor(private readonly info: SerialPortInfo = {}) {
    super();
  }

  /** True between open() and close(). */
  get opened(): boolean {
    return this.isOpen;
  }

  /** SerialPort.readable; null while closed. */
  get readable(): ReadableStream<Uint8Array> | null {
    if (!this.isOpen) return null;
    this.readableStream ??= new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        // Chrome hands out a new stream after a cancel; so does the getter above.
        this.controller = null;
        this.readableStream = null;
      },
    });
    return this.readableStream;
  }

  /** SerialPort.writable; null while closed. */
  get writable(): WritableStream<Uint8Array> | null {
    if (!this.isOpen) return null;
    this.writableStream ??= new WritableStream<Uint8Array>({
      write: (chunk) => this.onData(chunk.slice()),
    });
    return this.writableStream;
  }

  /** SerialPort.open(). */
  async open(options: SerialOptions): Promise<void> {
    if (this.isOpen) throw new DOMException('The port is already open.', 'InvalidStateError');
    if (!(options.baudRate > 0)) throw new TypeError('Requested baud rate must be greater than zero.');
    this.opens.push({ ...options });
    this.isOpen = true;
  }

  /** SerialPort.close(); like Chrome, fails while a reader or writer holds a lock. */
  async close(): Promise<void> {
    if (!this.isOpen) throw new DOMException('The port is already closed.', 'InvalidStateError');
    if (this.readableStream?.locked) throw new TypeError('Cannot cancel a locked stream');
    if (this.writableStream?.locked) throw new TypeError('Cannot abort a locked stream');
    this.controller?.close();
    this.controller = null;
    this.readableStream = null;
    this.writableStream = null;
    this.isOpen = false;
  }

  /** SerialPort.forget(). */
  async forget(): Promise<void> {
    if (this.isOpen) await this.close();
  }

  /** SerialPort.getInfo(). */
  getInfo(): SerialPortInfo {
    return { ...this.info };
  }

  /** SerialPort.setSignals(); the calls are kept in `signals`. */
  async setSignals(signals: SerialOutputSignals): Promise<void> {
    if (!this.isOpen) throw new DOMException('The port is closed.', 'InvalidStateError');
    this.signals.push({ ...signals });
  }

  /** SerialPort.getSignals(); all lines idle. */
  async getSignals(): Promise<SerialInputSignals> {
    if (!this.isOpen) throw new DOMException('The port is closed.', 'InvalidStateError');
    return { dataCarrierDetect: false, clearToSend: false, ringIndicator: false, dataSetReady: false };
  }

  /** Called with each chunk the host writes. */
  protected abstract onData(bytes: Uint8Array): void | Promise<void>;

  /** Sends bytes to the host as one chunk; dropped while the port is closed. */
  protected respond(bytes: ArrayLike<number>): void {
    if (!this.isOpen || bytes.length === 0) return;
    // Touch the getter so the stream exists even if the host has not asked for it yet.
    if (this.readable && this.controller) this.controller.enqueue(Uint8Array.from(bytes));
  }
}
