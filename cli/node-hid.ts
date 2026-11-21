// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A USB HID device of this computer in the shape of the browser's WebHID device, so the
 * GD-77 flasher and reader written for the page run unchanged. Built on the `node-hid`
 * package, of which only the parts named here are used.
 */
import { FakeHidInputReportEvent } from '../src/sim/hid.ts';

/** One HID device as `node-hid` lists it. */
export interface HidInfo {
  vendorId: number;
  productId: number;
  path?: string;
  product?: string;
  serialNumber?: string;
}

/** An open device of the `node-hid` package. */
export interface NativeHid {
  on(event: 'data', listener: (data: Uint8Array) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  write(data: Buffer): Promise<number>;
  close(): Promise<void>;
}

/** The part of the `node-hid` package this file uses. */
export interface HidModule {
  devicesAsync(): Promise<HidInfo[]>;
  HIDAsync: { open(path: string): Promise<NativeHid> };
}

/** WebHID's HIDDevice over a device of this computer. Cast it to `HIDDevice` to hand it to a flasher. */
export class NodeHidDevice extends EventTarget {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  /**
   * node-hid cannot read the report descriptor, so there are no collections. The GD-77
   * code then uses the framing it knows the radio to have: numbered reports.
   */
  readonly collections: HIDCollectionInfo[] = [];
  private native: NativeHid | null = null;

  /** A closed device. */
  constructor(
    private readonly hid: HidModule,
    private readonly info: HidInfo & { path: string },
  ) {
    super();
    this.vendorId = info.vendorId;
    this.productId = info.productId;
    this.productName = info.product ?? '';
  }

  /** HIDDevice.opened. */
  get opened(): boolean {
    return this.native !== null;
  }

  /** HIDDevice.open(); input reports arrive as 'inputreport' events from here on. */
  async open(): Promise<void> {
    if (this.native) throw new DOMException('The device is already open.', 'InvalidStateError');
    const native = await this.hid.HIDAsync.open(this.info.path);
    native.on('data', (data) => {
      // With numbered reports, which is what `collections` being empty makes the flashers
      // assume, hidapi puts the report ID first and WebHID hands it over separately.
      const bytes = Uint8Array.from(data);
      const view = new DataView(bytes.buffer, Math.min(1, bytes.length));
      this.dispatchEvent(new FakeHidInputReportEvent(this as unknown as HIDDevice, bytes[0] ?? 0, view));
    });
    // An unplugged radio just stops answering; the flashers time out and say so.
    native.on('error', () => {});
    this.native = native;
  }

  /** HIDDevice.close(). */
  async close(): Promise<void> {
    const native = this.native;
    this.native = null;
    await native?.close();
  }

  /** HIDDevice.sendReport(): hidapi wants the report ID as the first byte, 0 for unnumbered reports. */
  async sendReport(reportId: number, data: BufferSource): Promise<void> {
    if (!this.native) throw new DOMException('The device is closed.', 'InvalidStateError');
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    await this.native.write(Buffer.from([reportId, ...bytes]));
  }
}
