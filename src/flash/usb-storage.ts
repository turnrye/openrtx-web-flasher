// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * SCSI commands to a USB drive, for radios whose bootloader takes its firmware through
 * vendor commands on one.
 *
 * Follows the USB Mass Storage Class Bulk-Only Transport specification, revision 1.0: a
 * 31-byte command block wrapper, an optional data stage, a 13-byte status wrapper
 * (sections 5.1 and 5.2), and the reset recovery of section 5.3.4. Two things are done
 * the way Linux's usb-storage driver does them, because that is the host these radios
 * were worked out with: a status wrapper that arrives in place of the data is accepted,
 * and a failed command is followed by REQUEST SENSE.
 *
 * Browsers do not hand a mass-storage interface to a page, and operating systems keep it
 * for their own driver, so this only works from the command line, with a USB library
 * that can take the interface over.
 */
import { FlashError } from './types.ts';

const MASS_STORAGE_CLASS = 0x08;
const SCSI_SUBCLASS = 0x06;
const BULK_ONLY_PROTOCOL = 0x50;

/** "USBC", little-endian: starts a command block wrapper. */
export const CBW_SIGNATURE = 0x43425355;
/** "USBS", little-endian: starts a command status wrapper. */
export const CSW_SIGNATURE = 0x53425355;
export const CBW_SIZE = 31;
export const CSW_SIZE = 13;
/** bmCBWFlags of a command whose data goes to the host. */
export const CBW_DATA_IN = 0x80;
/** Class request "Bulk-Only Mass Storage Reset". */
export const BULK_ONLY_RESET = 0xff;

/** bCSWStatus values. */
const CSW_PASSED = 0;
const CSW_FAILED = 1;

/** REQUEST SENSE for the 18 bytes of fixed-format sense data. */
const REQUEST_SENSE = Uint8Array.of(0x03, 0, 0, 0, 18, 0);

/** Text of a thrown value. */
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Copies a DataView's bytes into a plain Uint8Array. */
function bytesOf(view: DataView | undefined): Uint8Array {
  if (!view) return new Uint8Array(0);
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
}

/** Builds a command block wrapper. */
export function commandBlockWrapper(
  tag: number,
  dataLength: number,
  dataIn: boolean,
  cdb: Uint8Array,
): Uint8Array {
  const cbw = new Uint8Array(CBW_SIZE);
  const view = new DataView(cbw.buffer);
  view.setUint32(0, CBW_SIGNATURE, true);
  view.setUint32(4, tag, true);
  view.setUint32(8, dataLength, true);
  cbw[12] = dataIn ? CBW_DATA_IN : 0;
  cbw[13] = 0; // logical unit 0
  cbw[14] = cdb.length;
  cbw.set(cdb, 15);
  return cbw;
}

/** The status a command ended with, or null when `bytes` is not the status wrapper for `tag`. */
function statusOf(bytes: Uint8Array, tag: number): number | null {
  if (bytes.length !== CSW_SIZE) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== CSW_SIGNATURE || view.getUint32(4, true) !== tag) return null;
  return bytes[12];
}

/** A claimed mass-storage interface and the two kinds of command the flashers send. */
export class UsbStorage {
  private tag = 0;

  private constructor(
    private readonly dev: USBDevice,
    private readonly interfaceNumber: number,
    private readonly endpointIn: number,
    private readonly endpointOut: number,
  ) {}

  /**
   * Opens the device and claims its Bulk-Only mass-storage interface. Throws a
   * FlashError when the device has none or the interface cannot be claimed.
   */
  static async open(dev: USBDevice): Promise<UsbStorage> {
    try {
      if (!dev.opened) await dev.open();
      if (!dev.configuration) {
        await dev.selectConfiguration(dev.configurations[0]?.configurationValue ?? 1);
      }
    } catch (e) {
      throw new FlashError(`Could not open the USB device: ${messageOf(e)}`);
    }
    const isStorage = (a: USBAlternateInterface) =>
      a.interfaceClass === MASS_STORAGE_CLASS &&
      a.interfaceSubclass === SCSI_SUBCLASS &&
      a.interfaceProtocol === BULK_ONLY_PROTOCOL;
    const iface = dev.configuration?.interfaces.find((i) => i.alternates.some(isStorage));
    const alternate = iface?.alternates.find(isStorage);
    const bulk = (direction: USBDirection) =>
      alternate?.endpoints.find((e) => e.type === 'bulk' && e.direction === direction)?.endpointNumber;
    const endpointIn = bulk('in');
    const endpointOut = bulk('out');
    if (!iface || endpointIn === undefined || endpointOut === undefined) {
      throw new FlashError('This USB device is not a USB drive. Is the radio in flashing mode?');
    }
    try {
      await dev.claimInterface(iface.interfaceNumber);
    } catch (e) {
      // The command line's device says what to do about it on this computer.
      if (e instanceof FlashError) throw e;
      throw new FlashError(`Could not take over the radio's USB drive: ${messageOf(e)}`);
    }
    return new UsbStorage(dev, iface.interfaceNumber, endpointIn, endpointOut);
  }

  /** Releases the interface and closes the device; never throws. */
  async close(): Promise<void> {
    try {
      await this.dev.releaseInterface(this.interfaceNumber);
    } catch {
      // already gone
    }
    try {
      await this.dev.close();
    } catch {
      // already gone
    }
  }

  /** Sends a command with `data` for the device. True when the device says it passed. */
  async write(cdb: Uint8Array, data: Uint8Array): Promise<boolean> {
    const { status } = await this.transact(cdb, data, 0);
    if (status === CSW_FAILED) await this.requestSense();
    return status === CSW_PASSED;
  }

  /**
   * Sends a command and reads up to `length` bytes. Null when the device failed the
   * command, which is how a device with nothing to say may answer.
   */
  async read(cdb: Uint8Array, length: number): Promise<Uint8Array | null> {
    const { status, data } = await this.transact(cdb, null, length);
    if (status === CSW_FAILED) await this.requestSense();
    return status === CSW_PASSED ? data : null;
  }

  /** Fetches the sense data of a failed command, as usb-storage does, and drops it. */
  private async requestSense(): Promise<void> {
    await this.transact(REQUEST_SENSE, null, 18);
  }

  /** One command: wrapper out, data either way, status in. */
  private async transact(
    cdb: Uint8Array,
    out: Uint8Array | null,
    inLength: number,
  ): Promise<{ status: number; data: Uint8Array }> {
    const tag = (this.tag = (this.tag + 1) >>> 0);
    const cbw = commandBlockWrapper(tag, out ? out.length : inLength, out === null, cdb);
    let data: Uint8Array = new Uint8Array(0);
    try {
      const sent = await this.dev.transferOut(this.endpointOut, cbw as Uint8Array<ArrayBuffer>);
      if (sent.status !== 'ok') throw new Error(`the command was refused (${sent.status})`);

      if (out) {
        const result = await this.dev.transferOut(this.endpointOut, out as Uint8Array<ArrayBuffer>);
        if (result.status === 'stall') await this.dev.clearHalt('out', this.endpointOut);
      } else if (inLength > 0) {
        const result = await this.dev.transferIn(this.endpointIn, inLength);
        if (result.status === 'stall') await this.dev.clearHalt('in', this.endpointIn);
        else data = bytesOf(result.data);
        // A device with no data may send its status straight away.
        const skipped = statusOf(data, tag);
        if (skipped !== null) return { status: skipped, data: new Uint8Array(0) };
      }

      let csw = await this.dev.transferIn(this.endpointIn, CSW_SIZE);
      if (csw.status === 'stall') {
        await this.dev.clearHalt('in', this.endpointIn);
        csw = await this.dev.transferIn(this.endpointIn, CSW_SIZE);
      }
      const status = csw.status === 'ok' ? statusOf(bytesOf(csw.data), tag) : null;
      if (status === null || status > CSW_FAILED) throw new Error('its status reply was not valid');
      return { status, data };
    } catch (e) {
      await this.resetRecovery();
      throw new FlashError(`The radio's USB drive stopped answering: ${messageOf(e)}`);
    }
  }

  /** Reset recovery: the class reset, then both endpoints cleared; never throws. */
  private async resetRecovery(): Promise<void> {
    try {
      await this.dev.controlTransferOut({
        requestType: 'class',
        recipient: 'interface',
        request: BULK_ONLY_RESET,
        value: 0,
        index: this.interfaceNumber,
      });
      await this.dev.clearHalt('in', this.endpointIn);
      await this.dev.clearHalt('out', this.endpointOut);
    } catch {
      // nothing more can be done from here
    }
  }
}
