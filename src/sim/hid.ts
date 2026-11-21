// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Minimal fake WebHID device for the simulators. It models the parts of Chrome's
 * HIDDevice a flasher uses: open/close, sendReport with the report ID checked against
 * the descriptor, and 'inputreport' events carrying a DataView without the report ID.
 */

/** The event Chrome fires for an input report. */
export class FakeHidInputReportEvent extends Event {
  /** Builds an 'inputreport' event for `device`. */
  constructor(
    readonly device: HIDDevice,
    readonly reportId: number,
    readonly data: DataView,
  ) {
    super('inputreport');
  }
}

/** Identity and report descriptor of a fake device. */
export interface FakeHidInfo {
  vendorId: number;
  productId: number;
  productName: string;
  /** Empty means "descriptor unknown": report IDs and sizes are then not checked. */
  collections: HIDCollectionInfo[];
}

/** Builds a HIDReportInfo of `bytes` plain data bytes. */
export function byteReport(reportId: number, bytes: number): HIDReportInfo {
  return { reportId, items: [{ reportSize: 8, reportCount: bytes, isAbsolute: true }] };
}

/** Size in bytes of one report, not counting the report ID. */
export function reportBytes(report: HIDReportInfo): number {
  let bits = 0;
  for (const item of report.items ?? []) bits += (item.reportSize ?? 0) * (item.reportCount ?? 0);
  return Math.ceil(bits / 8);
}

/** Lists the reports of one kind in a collection tree. */
export function listReports(
  collections: readonly HIDCollectionInfo[],
  kind: 'inputReports' | 'outputReports',
): HIDReportInfo[] {
  const out: HIDReportInfo[] = [];
  for (const c of collections) {
    out.push(...(c[kind] ?? []), ...listReports(c.children ?? [], kind));
  }
  return out;
}

/** Fake HIDDevice; subclasses implement the device behind it. */
export abstract class FakeHidDevice extends EventTarget implements HIDDevice {
  oninputreport: ((this: HIDDevice, ev: HIDInputReportEvent) => unknown) | null = null;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly collections: HIDCollectionInfo[];
  /** Every output report the host sent, as [reportId, data]. */
  readonly sent: [number, Uint8Array][] = [];

  private isOpen = false;

  /** Creates a closed device. */
  constructor(info: FakeHidInfo) {
    super();
    this.vendorId = info.vendorId;
    this.productId = info.productId;
    this.productName = info.productName;
    this.collections = info.collections;
  }

  /** HIDDevice.opened. */
  get opened(): boolean {
    return this.isOpen;
  }

  /** HIDDevice.open(). */
  async open(): Promise<void> {
    if (this.isOpen) throw new DOMException('The device is already open.', 'InvalidStateError');
    this.isOpen = true;
  }

  /** HIDDevice.close(). */
  async close(): Promise<void> {
    this.isOpen = false;
  }

  /** HIDDevice.forget(). */
  async forget(): Promise<void> {
    this.isOpen = false;
  }

  /** EventTarget.addEventListener() with WebHID's 'inputreport' overload. */
  override addEventListener(
    type: 'inputreport',
    listener: (this: this, ev: HIDInputReportEvent) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  override addEventListener(
    type: string,
    listener: unknown,
    options?: boolean | AddEventListenerOptions,
  ): void {
    super.addEventListener(type, listener as EventListenerOrEventListenerObject | null, options);
  }

  /** EventTarget.removeEventListener() with WebHID's 'inputreport' overload. */
  override removeEventListener(
    type: 'inputreport',
    callback: (this: this, ev: HIDInputReportEvent) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void;
  override removeEventListener(
    type: string,
    callback: unknown,
    options?: EventListenerOptions | boolean,
  ): void {
    super.removeEventListener(type, callback as EventListenerOrEventListenerObject | null, options);
  }

  /** HIDDevice.sendReport(); rejects IDs and sizes the descriptor does not allow. */
  async sendReport(reportId: number, data: BufferSource): Promise<void> {
    if (!this.isOpen) throw new DOMException('The device must be opened first.', 'InvalidStateError');
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
      : new Uint8Array(data).slice();
    const outputs = listReports(this.collections, 'outputReports');
    if (outputs.length > 0) {
      const report = outputs.find((r) => (r.reportId ?? 0) === reportId);
      if (!report || bytes.length > reportBytes(report)) {
        throw new DOMException('Failed to write the report.', 'NotAllowedError');
      }
    }
    this.sent.push([reportId, bytes]);
    this.onOutputReport(reportId, bytes);
  }

  /** HIDDevice.sendFeatureReport(); not used by any flasher. */
  async sendFeatureReport(): Promise<void> {
    throw new DOMException('Feature reports are not simulated.', 'NotSupportedError');
  }

  /** HIDDevice.receiveFeatureReport(); not used by any flasher. */
  async receiveFeatureReport(): Promise<DataView> {
    throw new DOMException('Feature reports are not simulated.', 'NotSupportedError');
  }

  /** Called for each output report; `data` excludes the report ID, as in WebHID. */
  protected abstract onOutputReport(reportId: number, data: Uint8Array): void;

  /** Fires an 'inputreport' event on a later microtask, like a device answering. */
  protected emitInputReport(reportId: number, data: Uint8Array): void {
    const copy = data.slice();
    queueMicrotask(() => {
      if (!this.isOpen) return;
      const event = new FakeHidInputReportEvent(this, reportId, new DataView(copy.buffer));
      this.oninputreport?.call(this, event);
      this.dispatchEvent(event);
    });
  }
}
