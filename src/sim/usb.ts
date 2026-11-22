// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A minimal fake WebUSB device with one DFU interface, for the simulators.
 *
 * It implements the USBDevice members the flashers use, serves the configuration and
 * string descriptors a DFU host reads, and hands DFU class requests to subclass hooks.
 * It is as picky as Chrome: transfers on a closed device or an unclaimed interface
 * reject, and a hook that throws SimStall answers the request with a stall.
 */

/** Thrown by a hook to stall the current control transfer. */
export class SimStall extends Error {}

/** Reply to DFU_GETSTATUS as the hooks produce it. */
export interface SimDfuStatus {
  status: number;
  pollTimeout: number;
  state: number;
}

/** Identity and descriptors of the fake device. */
export interface SimUsbOptions {
  vendorId: number;
  productId: number;
  productName: string;
  manufacturerName?: string;
  /** Name of each alternate setting of the DFU interface, in order; null for unnamed. */
  alternateNames: (string | null)[];
  /** wTransferSize reported in the DFU functional descriptor. */
  transferSize: number;
  /** When false, USBAlternateInterface.interfaceName is null, as on some platforms. */
  exposeInterfaceNames?: boolean;
  /** When false, GET_DESCRIPTOR requests stall, so the host must use its defaults. */
  serveDescriptors?: boolean;
}

const DFU_INTERFACE_NUMBER = 0;
const FIRST_NAME_STRING = 4;
const REQUEST_NAMES = ['DETACH', 'DNLOAD', 'UPLOAD', 'GETSTATUS', 'CLRSTATUS', 'GETSTATE', 'ABORT'];

/** Fake USB device exposing a single DFU interface. */
export abstract class SimUsbDevice implements USBDevice {
  readonly usbVersionMajor = 2;
  readonly usbVersionMinor = 0;
  readonly usbVersionSubminor = 0;
  readonly deviceClass = 0;
  readonly deviceSubclass = 0;
  readonly deviceProtocol = 0;
  readonly deviceVersionMajor = 2;
  readonly deviceVersionMinor = 0;
  readonly deviceVersionSubminor = 0;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly manufacturerName: string;
  readonly serialNumber = 'SIM0001';
  opened = false;
  /** Every DFU class request seen, in order: "DNLOAD 2 len=1024", "GETSTATUS"... */
  readonly requests: string[] = [];
  /** Alternate setting currently selected on the DFU interface. */
  protected currentAlternate = 0;
  /** Set when the device has dropped off the bus; every transfer then rejects. */
  protected disconnected = false;

  private configured = false;
  private claimed = false;
  private readonly options: SimUsbOptions;

  /** Builds a closed, unconfigured device. */
  constructor(options: SimUsbOptions) {
    this.options = options;
    this.vendorId = options.vendorId;
    this.productId = options.productId;
    this.productName = options.productName;
    this.manufacturerName = options.manufacturerName ?? 'Simulated';
  }

  /** DFU_DNLOAD arrived. */
  protected abstract onDnload(blockNum: number, data: Uint8Array): void;
  /** DFU_UPLOAD arrived; returns the bytes to send. */
  protected abstract onUpload(blockNum: number, length: number): Uint8Array;
  /** DFU_GETSTATUS arrived. */
  protected abstract onGetStatus(): SimDfuStatus;
  /** DFU_GETSTATE arrived; returns bState. */
  protected abstract onGetState(): number;
  /** DFU_CLRSTATUS arrived. */
  protected abstract onClrStatus(): void;
  /** DFU_ABORT arrived. */
  protected abstract onAbort(): void;

  /** Name of the selected alternate setting, or null. */
  protected get alternateName(): string | null {
    return this.options.alternateNames[this.currentAlternate] ?? null;
  }

  /** The only configuration, as WebUSB would describe it. */
  get configurations(): USBConfiguration[] {
    const alternates: USBAlternateInterface[] = this.options.alternateNames.map((name, i) => ({
      alternateSetting: i,
      interfaceClass: 0xfe,
      interfaceSubclass: 0x01,
      interfaceProtocol: 0x02,
      interfaceName: this.options.exposeInterfaceNames === false ? null : name,
      endpoints: [],
    }));
    const iface: USBInterface = {
      interfaceNumber: DFU_INTERFACE_NUMBER,
      alternate: alternates[this.currentAlternate],
      alternates,
      claimed: this.claimed,
    };
    return [{ configurationValue: 1, configurationName: null, interfaces: [iface] }];
  }

  /** The active configuration, null until one is selected. */
  get configuration(): USBConfiguration | null {
    return this.configured ? this.configurations[0] : null;
  }

  /** Opens the device. */
  async open(): Promise<void> {
    this.opened = true;
  }

  /** Closes the device and drops its claims. */
  async close(): Promise<void> {
    this.opened = false;
    this.claimed = false;
  }

  /** Not used by the flashers. */
  async forget(): Promise<void> {
    await this.close();
  }

  /** Selects configuration 1, the only one. */
  async selectConfiguration(configurationValue: number): Promise<void> {
    this.requireOpen();
    if (configurationValue !== 1) throw new Error('NotFoundError: no such configuration');
    this.configured = true;
    this.currentAlternate = 0;
  }

  /** Claims the DFU interface. */
  async claimInterface(interfaceNumber: number): Promise<void> {
    this.requireOpen();
    if (!this.configured) throw new Error('InvalidStateError: no configuration selected');
    if (interfaceNumber !== DFU_INTERFACE_NUMBER) throw new Error('NotFoundError: no such interface');
    this.claimed = true;
  }

  /** Releases the DFU interface. */
  async releaseInterface(interfaceNumber: number): Promise<void> {
    this.requireOpen();
    this.requireClaimed(interfaceNumber);
    this.claimed = false;
  }

  /** Selects an alternate setting of the claimed DFU interface. */
  async selectAlternateInterface(interfaceNumber: number, alternateSetting: number): Promise<void> {
    this.requireOpen();
    this.requireClaimed(interfaceNumber);
    if (alternateSetting < 0 || alternateSetting >= this.options.alternateNames.length) {
      throw new Error('NotFoundError: no such alternate setting');
    }
    this.currentAlternate = alternateSetting;
  }

  /** Device-to-host control transfer: DFU class requests and GET_DESCRIPTOR. */
  async controlTransferIn(setup: USBControlTransferParameters, length: number): Promise<USBInTransferResult> {
    this.requireOpen();
    try {
      const data = this.handleIn(setup, length);
      const cut = data.slice(0, length);
      return { status: 'ok', data: new DataView(cut.buffer, cut.byteOffset, cut.byteLength) };
    } catch (e) {
      if (e instanceof SimStall) return { status: 'stall' };
      throw e;
    }
  }

  /** Host-to-device control transfer: DFU class requests only. */
  async controlTransferOut(
    setup: USBControlTransferParameters,
    data?: BufferSource,
  ): Promise<USBOutTransferResult> {
    this.requireOpen();
    const bytes = toBytes(data);
    try {
      this.handleOut(setup, bytes);
      return { status: 'ok', bytesWritten: bytes.length };
    } catch (e) {
      if (e instanceof SimStall) return { status: 'stall', bytesWritten: 0 };
      throw e;
    }
  }

  /** Not used by the flashers. */
  async clearHalt(): Promise<void> {
    throw new Error('NotSupportedError: the simulator has no endpoints');
  }

  /** Not used by the flashers. */
  async transferIn(): Promise<USBInTransferResult> {
    throw new Error('NotSupportedError: the simulator has no endpoints');
  }

  /** Not used by the flashers. */
  async transferOut(): Promise<USBOutTransferResult> {
    throw new Error('NotSupportedError: the simulator has no endpoints');
  }

  /** Not used by the flashers. */
  async isochronousTransferIn(): Promise<USBIsochronousInTransferResult> {
    throw new Error('NotSupportedError: the simulator has no endpoints');
  }

  /** Not used by the flashers. */
  async isochronousTransferOut(): Promise<USBIsochronousOutTransferResult> {
    throw new Error('NotSupportedError: the simulator has no endpoints');
  }

  /** USB port reset: back to alternate 0. */
  async reset(): Promise<void> {
    this.requireOpen();
    this.currentAlternate = 0;
  }

  /** Routes one IN request. */
  private handleIn(setup: USBControlTransferParameters, length: number): Uint8Array {
    if (setup.requestType === 'standard' && setup.recipient === 'device' && setup.request === 6) {
      return this.descriptor(setup.value >> 8, setup.value & 0xff);
    }
    this.requireDfuRequest(setup);
    switch (setup.request) {
      case 2:
        this.requests.push(`UPLOAD ${setup.value} len=${length}`);
        return this.onUpload(setup.value, length);
      case 3: {
        this.requests.push('GETSTATUS');
        const st = this.onGetStatus();
        const t = st.pollTimeout;
        return Uint8Array.of(st.status, t & 0xff, (t >> 8) & 0xff, (t >> 16) & 0xff, st.state, 0);
      }
      case 5:
        this.requests.push('GETSTATE');
        return Uint8Array.of(this.onGetState());
      default:
        throw new SimStall(`unsupported IN request ${setup.request}`);
    }
  }

  /** Routes one OUT request. */
  private handleOut(setup: USBControlTransferParameters, data: Uint8Array): void {
    this.requireDfuRequest(setup);
    const name = REQUEST_NAMES[setup.request] ?? `request ${setup.request}`;
    this.requests.push(setup.request === 1 ? `DNLOAD ${setup.value} len=${data.length}` : name);
    switch (setup.request) {
      case 1:
        return this.onDnload(setup.value, data);
      case 4:
        return this.onClrStatus();
      case 6:
        return this.onAbort();
      default:
        throw new SimStall(`unsupported OUT request ${name}`);
    }
  }

  /** Rejects anything but a class request to the claimed DFU interface. */
  private requireDfuRequest(setup: USBControlTransferParameters): void {
    if (this.disconnected) throw new Error('NetworkError: the device was disconnected');
    if (setup.requestType !== 'class' || setup.recipient !== 'interface') {
      throw new SimStall('not a class request to an interface');
    }
    this.requireClaimed(setup.index & 0xff);
  }

  /** Throws like Chrome when the device is not open. */
  private requireOpen(): void {
    if (!this.opened) throw new Error('InvalidStateError: the device must be opened first');
  }

  /** Throws like Chrome when the interface is not claimed. */
  private requireClaimed(interfaceNumber: number): void {
    if (interfaceNumber !== DFU_INTERFACE_NUMBER || !this.claimed) {
      throw new Error('InvalidStateError: the interface has not been claimed');
    }
  }

  /** Builds the descriptor a GET_DESCRIPTOR asks for. */
  private descriptor(type: number, index: number): Uint8Array {
    if (this.disconnected) throw new Error('NetworkError: the device was disconnected');
    if (this.options.serveDescriptors === false) throw new SimStall('descriptors disabled');
    if (type === 2 && index === 0) return this.configurationDescriptor();
    if (type === 3) return this.stringDescriptor(index);
    throw new SimStall(`no descriptor ${type}/${index}`);
  }

  /** Configuration, one interface descriptor per alternate, then the DFU functional one. */
  private configurationDescriptor(): Uint8Array {
    const names = this.options.alternateNames;
    const size = this.options.transferSize;
    const total = 9 + names.length * 9 + 9;
    const out = [9, 2, total & 0xff, total >> 8, 1, 1, 0, 0xc0, 50];
    names.forEach((name, i) => {
      out.push(9, 4, DFU_INTERFACE_NUMBER, i, 0, 0xfe, 0x01, 0x02, name === null ? 0 : FIRST_NAME_STRING + i);
    });
    out.push(9, 0x21, 0x0b, 0xff, 0x00, size & 0xff, size >> 8, 0x1a, 0x01);
    return Uint8Array.from(out);
  }

  /** String descriptor: 0 is the language list, 4 and up are the alternate names. */
  private stringDescriptor(index: number): Uint8Array {
    if (index === 0) return Uint8Array.of(4, 3, 0x09, 0x04);
    const fixed = [this.manufacturerName, this.productName, this.serialNumber];
    const text =
      index < FIRST_NAME_STRING ? fixed[index - 1] : this.options.alternateNames[index - FIRST_NAME_STRING];
    if (text === null || text === undefined) throw new SimStall(`no string ${index}`);
    const out = [2 + text.length * 2, 3];
    for (const ch of text) out.push(ch.charCodeAt(0) & 0xff, ch.charCodeAt(0) >> 8);
    return Uint8Array.from(out);
  }
}

/** Copies a BufferSource into a Uint8Array. */
function toBytes(data: BufferSource | undefined): Uint8Array {
  if (!data) return new Uint8Array(0);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  return new Uint8Array(data).slice();
}
