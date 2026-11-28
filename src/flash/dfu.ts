// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * USB DFU 1.1 and ST DfuSe primitives over WebUSB control transfers.
 *
 * Written from the USB DFU 1.1 specification and ST's AN3156 (DfuSe protocol used by
 * the STM32 bootloader). Two ideas come from devanlai/webdfu (ISC): reading the
 * configuration descriptor by hand to reach the DFU functional descriptor and the
 * interface names WebUSB does not always expose, and the grammar of the DfuSe
 * memory-layout string.
 */
import { bytesOf } from '../bytes.ts';
import { FlashError, messageOf, type FlashContext } from './types.ts';

/** DFU class requests (bRequest). */
export const DfuRequest = {
  DETACH: 0,
  DNLOAD: 1,
  UPLOAD: 2,
  GETSTATUS: 3,
  CLRSTATUS: 4,
  GETSTATE: 5,
  ABORT: 6,
} as const;

/** DFU device states (bState). */
export const DfuState = {
  appIDLE: 0,
  appDETACH: 1,
  dfuIDLE: 2,
  dfuDNLOAD_SYNC: 3,
  dfuDNBUSY: 4,
  dfuDNLOAD_IDLE: 5,
  dfuMANIFEST_SYNC: 6,
  dfuMANIFEST: 7,
  dfuMANIFEST_WAIT_RESET: 8,
  dfuUPLOAD_IDLE: 9,
  dfuERROR: 10,
} as const;

/** DfuSe commands, sent as the first byte of a DNLOAD at wBlockNum 0. */
export const DfuSeCommand = {
  SET_ADDRESS: 0x21,
  ERASE: 0x41,
} as const;

const STATE_NAMES = [
  'appIDLE',
  'appDETACH',
  'dfuIDLE',
  'dfuDNLOAD-SYNC',
  'dfuDNBUSY',
  'dfuDNLOAD-IDLE',
  'dfuMANIFEST-SYNC',
  'dfuMANIFEST',
  'dfuMANIFEST-WAIT-RESET',
  'dfuUPLOAD-IDLE',
  'dfuERROR',
];

const STATUS_TEXT = [
  'OK',
  'errTARGET: the file is not for this device, or the address is not valid',
  'errFILE: the device rejected the file',
  'errWRITE: the device could not write its memory',
  'errERASE: the erase failed',
  'errCHECK_ERASE: the memory was not blank after the erase',
  'errPROG: programming failed',
  'errVERIFY: the device failed its own verify',
  'errADDRESS: the address is out of range',
  'errNOTDONE: the device expected more data',
  'errFIRMWARE: the firmware on the device is corrupt',
  'errVENDOR: vendor error (on STM32 usually read or write protection)',
  'errUSBR: unexpected USB reset',
  'errPOR: unexpected power-on reset',
  'errUNKNOWN: unknown error',
  'errSTALLEDPKT: the device stalled a request it did not expect',
];

const DFU_INTERFACE_CLASS = 0xfe;
const DFU_INTERFACE_SUBCLASS = 0x01;
const DESCRIPTOR_CONFIGURATION = 2;
const DESCRIPTOR_STRING = 3;
const DESCRIPTOR_INTERFACE = 4;
const DESCRIPTOR_DFU_FUNCTIONAL = 0x21;
const LANG_EN_US = 0x0409;
/** Polls allowed while a download stays busy, so a stuck device cannot hang the page. */
const MAX_BUSY_POLLS = 200;

/** Name of a DFU state for messages. */
export function dfuStateName(state: number): string {
  return STATE_NAMES[state] ?? `state ${state}`;
}

/** Description of a DFU status code for messages. */
export function dfuStatusText(status: number): string {
  return STATUS_TEXT[status] ?? `status ${status}`;
}

/** Formats an address as 0x08000000. */
export function hex32(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
}

/** Reply to DFU_GETSTATUS. */
export interface DfuStatus {
  /** bStatus, 0 is OK. */
  status: number;
  /** bwPollTimeout in milliseconds. */
  pollTimeout: number;
  /** bState, see DfuState. */
  state: number;
}

/** The DFU functional descriptor. */
export interface DfuFunctional {
  attributes: number;
  detachTimeout: number;
  transferSize: number;
  dfuVersion: number;
}

/** One erasable flash sector. */
export interface FlashSector {
  start: number;
  size: number;
  readable: boolean;
  erasable: boolean;
  writable: boolean;
}

/** Chips with a built-in fallback layout. */
export type Stm32Chip = 'f405' | 'h743';

/** Builds a run of equal-sized read/erase/write sectors. */
function sectorRun(start: number, count: number, size: number): FlashSector[] {
  return Array.from({ length: count }, (_, i) => ({
    start: start + i * size,
    size,
    readable: true,
    erasable: true,
    writable: true,
  }));
}

/** STM32F405/F407 internal flash: 4 x 16K, 1 x 64K, 7 x 128K from 0x08000000. */
export const STM32F405_LAYOUT: readonly FlashSector[] = [
  ...sectorRun(0x08000000, 4, 0x4000),
  ...sectorRun(0x08010000, 1, 0x10000),
  ...sectorRun(0x08020000, 7, 0x20000),
];

/** STM32H743 internal flash: 16 x 128K from 0x08000000. */
export const STM32H743_LAYOUT: readonly FlashSector[] = sectorRun(0x08000000, 16, 0x20000);

/** Built-in layout for a chip, for devices that do not report one. */
export function fallbackLayout(chip: Stm32Chip): FlashSector[] {
  return [...(chip === 'h743' ? STM32H743_LAYOUT : STM32F405_LAYOUT)];
}

/**
 * Parses a DfuSe memory-layout string such as
 * "@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg" into sectors.
 * Returns null when the string holds no layout.
 */
export function parseMemoryLayout(name: string): FlashSector[] | null {
  const parts = name.split('/');
  const sectors: FlashSector[] = [];
  // parts: name, address, runs, address, runs, ...
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const address = /^\s*0x([0-9a-f]{1,8})\s*$/i.exec(parts[i]);
    if (!address) return null;
    let start = parseInt(address[1], 16);
    for (const run of parts[i + 1].split(',')) {
      const m = /^\s*(\d+)\s*\*\s*(\d+)\s?([ BKM])\s*([a-g])\s*$/.exec(run);
      if (!m) return null;
      const unit = m[3] === 'K' ? 1024 : m[3] === 'M' ? 1024 * 1024 : 1;
      const size = parseInt(m[2], 10) * unit;
      const flags = m[4].charCodeAt(0) - 0x60; // a=1 ... g=7: bit0 read, bit1 erase, bit2 write
      for (let n = parseInt(m[1], 10); n > 0; n--) {
        sectors.push({
          start,
          size,
          readable: (flags & 1) !== 0,
          erasable: (flags & 2) !== 0,
          writable: (flags & 4) !== 0,
        });
        start += size;
      }
    }
  }
  return sectors.length > 0 ? sectors : null;
}

/**
 * Sectors that the byte range [address, address + length) touches, in address order.
 * Throws when part of the range lies outside the layout.
 */
export function sectorsTouched(
  layout: readonly FlashSector[],
  address: number,
  length: number,
): FlashSector[] {
  const end = address + length;
  const hit = layout
    .filter((s) => s.start < end && s.start + s.size > address)
    .sort((a, b) => a.start - b.start);
  let cursor = address;
  for (const s of hit) {
    if (s.start > cursor) break;
    cursor = Math.max(cursor, s.start + s.size);
  }
  if (length > 0 && cursor < end) {
    throw new FlashError(
      `The firmware does not fit this device: ${hex32(cursor)} is outside its flash memory.`,
    );
  }
  return hit;
}

/** What the configuration descriptor says about one DFU interface. */
interface DfuDescriptors {
  functional: DfuFunctional | null;
  /** iInterface string index per alternate setting. */
  nameIndex: Map<number, number>;
}

/** Walks a raw configuration descriptor for the DFU bits of one interface. */
function parseConfigurationDescriptor(raw: Uint8Array, interfaceNumber: number): DfuDescriptors {
  const out: DfuDescriptors = { functional: null, nameIndex: new Map() };
  let inInterface = false;
  for (let p = 0; p + 2 <= raw.length;) {
    const length = raw[p];
    const type = raw[p + 1];
    if (length < 2 || p + length > raw.length) break;
    if (type === DESCRIPTOR_INTERFACE && length >= 9) {
      inInterface = raw[p + 2] === interfaceNumber;
      if (inInterface) out.nameIndex.set(raw[p + 3], raw[p + 8]);
    } else if (type === DESCRIPTOR_DFU_FUNCTIONAL && length >= 7 && inInterface) {
      out.functional = {
        attributes: raw[p + 2],
        detachTimeout: raw[p + 3] | (raw[p + 4] << 8),
        transferSize: raw[p + 5] | (raw[p + 6] << 8),
        dfuVersion: length >= 9 ? raw[p + 7] | (raw[p + 8] << 8) : 0x0100,
      };
    }
    p += length;
  }
  return out;
}

/** A claimed DFU interface and the requests it understands. */
export class DfuDevice {
  /** DFU functional descriptor, or null when it could not be read. */
  functional: DfuFunctional | null = null;
  /** Name of the selected alternate setting (the DfuSe layout string), if any. */
  interfaceName: string | null = null;
  /** Sectors parsed from the layout string, or null when the device reports none. */
  layout: FlashSector[] | null = null;

  private constructor(
    readonly dev: USBDevice,
    readonly interfaceNumber: number,
    readonly alternateSetting: number,
    private readonly ctx: FlashContext,
  ) {}

  /**
   * Opens the device, claims its DFU interface and selects the "@Internal Flash"
   * alternate setting (alternate 0 when no setting has that name).
   */
  static async open(dev: USBDevice, ctx: FlashContext): Promise<DfuDevice> {
    try {
      if (!dev.opened) await dev.open();
      if (!dev.configuration) {
        await dev.selectConfiguration(dev.configurations[0]?.configurationValue ?? 1);
      }
    } catch (e) {
      throw new FlashError(`Could not open the USB device: ${messageOf(e)}`);
    }
    const isDfu = (a: USBAlternateInterface) =>
      a.interfaceClass === DFU_INTERFACE_CLASS && a.interfaceSubclass === DFU_INTERFACE_SUBCLASS;
    const iface = dev.configuration?.interfaces.find((i) => i.alternates.some(isDfu));
    if (!iface) {
      throw new FlashError('This USB device has no DFU interface. Is it in bootloader mode?');
    }
    try {
      await dev.claimInterface(iface.interfaceNumber);
    } catch (e) {
      throw new FlashError(`Could not claim the DFU interface: ${messageOf(e)}`);
    }

    const descriptors = await readDfuDescriptors(dev, iface.interfaceNumber, ctx);
    const names = new Map<number, string | null>();
    for (const alt of iface.alternates.filter(isDfu)) {
      let name = alt.interfaceName ?? null;
      const index = descriptors.nameIndex.get(alt.alternateSetting);
      if (name === null && index) name = await readStringDescriptor(dev, index);
      names.set(alt.alternateSetting, name);
    }
    const settings = [...names.keys()];
    const chosen =
      settings.find((s) => names.get(s)?.startsWith('@Internal Flash')) ??
      (settings.includes(0) ? 0 : settings[0]);

    // WebUSB starts on alternate 0; only send SET_INTERFACE when it changes something.
    if (iface.alternate?.alternateSetting !== chosen) {
      try {
        await dev.selectAlternateInterface(iface.interfaceNumber, chosen);
      } catch (e) {
        throw new FlashError(`Could not select DFU alternate setting ${chosen}: ${messageOf(e)}`);
      }
    }

    const dfu = new DfuDevice(dev, iface.interfaceNumber, chosen, ctx);
    dfu.functional = descriptors.functional;
    dfu.interfaceName = names.get(chosen) ?? null;
    dfu.layout = dfu.interfaceName ? parseMemoryLayout(dfu.interfaceName) : null;
    return dfu;
  }

  /** Releases the interface and closes the device; never throws. */
  async close(): Promise<void> {
    try {
      await this.dev.releaseInterface(this.interfaceNumber);
    } catch {
      // already gone, e.g. after a DfuSe leave
    }
    try {
      await this.dev.close();
    } catch {
      // already gone
    }
  }

  /** DFU_DNLOAD: sends `data` as block `blockNum`. */
  async download(blockNum: number, data: Uint8Array): Promise<void> {
    await this.requestOut(DfuRequest.DNLOAD, 'DNLOAD', blockNum, data);
  }

  /** DFU_UPLOAD: reads up to `length` bytes of block `blockNum`. */
  async upload(blockNum: number, length: number): Promise<Uint8Array> {
    return this.requestIn(DfuRequest.UPLOAD, 'UPLOAD', blockNum, length);
  }

  /** DFU_GETSTATUS: one status read, no waiting. */
  async getStatus(): Promise<DfuStatus> {
    const raw = await this.requestIn(DfuRequest.GETSTATUS, 'GETSTATUS', 0, 6);
    if (raw.length < 6) throw new FlashError('The device sent a short DFU status reply.');
    return { status: raw[0], pollTimeout: raw[1] | (raw[2] << 8) | (raw[3] << 16), state: raw[4] };
  }

  /** DFU_CLRSTATUS: leaves dfuERROR. */
  async clearStatus(): Promise<void> {
    await this.requestOut(DfuRequest.CLRSTATUS, 'CLRSTATUS', 0);
  }

  /** DFU_ABORT: ends a transfer and returns to dfuIDLE. */
  async abort(): Promise<void> {
    await this.requestOut(DfuRequest.ABORT, 'ABORT', 0);
  }

  /** DFU_GETSTATE: the state byte, without the side effects of GETSTATUS. */
  async getState(): Promise<number> {
    const raw = await this.requestIn(DfuRequest.GETSTATE, 'GETSTATE', 0, 1);
    if (raw.length < 1) throw new FlashError('The device sent an empty DFU state reply.');
    return raw[0];
  }

  /**
   * Polls GETSTATUS after a DNLOAD until the device is done, sleeping bwPollTimeout
   * between polls. Throws a FlashError naming `what` if it ends anywhere but
   * dfuDNLOAD-IDLE.
   */
  async waitDownloadIdle(what: string): Promise<void> {
    let st = await this.getStatus();
    for (let polls = 0; st.state === DfuState.dfuDNBUSY || st.state === DfuState.dfuDNLOAD_SYNC;) {
      if (++polls > MAX_BUSY_POLLS) {
        throw new FlashError(`The device stayed busy during ${what}.`);
      }
      if (st.pollTimeout > 0) await this.ctx.sleep(st.pollTimeout);
      st = await this.getStatus();
    }
    if (st.state === DfuState.dfuERROR) {
      await this.clearStatus().catch(() => {});
      throw new FlashError(`The device reported an error during ${what}: ${dfuStatusText(st.status)}.`);
    }
    if (st.state !== DfuState.dfuDNLOAD_IDLE) {
      throw new FlashError(`Unexpected DFU state ${dfuStateName(st.state)} after ${what}.`);
    }
  }

  /** Clears any error and aborts any transfer so the device is in dfuIDLE. */
  async abortToIdle(): Promise<void> {
    let st = await this.getStatus();
    if (st.state === DfuState.dfuERROR) {
      await this.clearStatus();
      st = await this.getStatus();
    }
    if (st.state !== DfuState.dfuIDLE) {
      await this.abort();
      st = await this.getStatus();
    }
    if (st.state !== DfuState.dfuIDLE) {
      throw new FlashError(`The device did not return to dfuIDLE (it is in ${dfuStateName(st.state)}).`);
    }
  }

  /** DfuSe: sets the address pointer used by the following block transfers. */
  async setAddress(address: number): Promise<void> {
    await this.dfuseCommand(DfuSeCommand.SET_ADDRESS, address, `set address ${hex32(address)}`);
  }

  /** DfuSe: erases the flash sector that contains `address`. */
  async eraseSector(address: number): Promise<void> {
    await this.dfuseCommand(DfuSeCommand.ERASE, address, `erase of sector ${hex32(address)}`);
  }

  /** DfuSe: writes `data` as block `blockNum` (2 or more) and waits until it is done. */
  async writeBlock(blockNum: number, data: Uint8Array, what: string): Promise<void> {
    await this.download(blockNum, data);
    await this.waitDownloadIdle(what);
  }

  /** Sends a DfuSe command with a 32-bit little-endian address and waits for it. */
  private async dfuseCommand(command: number, address: number, what: string): Promise<void> {
    await this.download(0, dfuseCommandBytes(command, address));
    await this.waitDownloadIdle(what);
  }

  /** Class request to the DFU interface, host to device. */
  private async requestOut(request: number, name: string, value: number, data?: Uint8Array) {
    let result: USBOutTransferResult;
    try {
      // The cast only narrows the buffer type; WebUSB takes any view.
      const payload = data as Uint8Array<ArrayBuffer> | undefined;
      result = await this.dev.controlTransferOut(this.setup(request, value), payload);
    } catch (e) {
      throw new FlashError(`USB ${name} failed: ${messageOf(e)}`);
    }
    if (result.status !== 'ok') {
      throw new FlashError(`The device refused DFU ${name} (${result.status}).`);
    }
  }

  /** Class request to the DFU interface, device to host. */
  private async requestIn(request: number, name: string, value: number, length: number) {
    let result: USBInTransferResult;
    try {
      result = await this.dev.controlTransferIn(this.setup(request, value), length);
    } catch (e) {
      throw new FlashError(`USB ${name} failed: ${messageOf(e)}`);
    }
    if (result.status !== 'ok') {
      throw new FlashError(`The device refused DFU ${name} (${result.status}).`);
    }
    return bytesOf(result.data);
  }

  /** Setup packet fields for a DFU class request. */
  private setup(request: number, value: number): USBControlTransferParameters {
    return {
      requestType: 'class',
      recipient: 'interface',
      request,
      value,
      index: this.interfaceNumber,
    };
  }
}

/** Bytes of a DfuSe command: opcode then a 32-bit little-endian address. */
export function dfuseCommandBytes(command: number, address: number): Uint8Array {
  return Uint8Array.of(
    command,
    address & 0xff,
    (address >>> 8) & 0xff,
    (address >>> 16) & 0xff,
    (address >>> 24) & 0xff,
  );
}

/** Standard GET_DESCRIPTOR to the device; null when the device refuses. */
async function getDescriptor(
  dev: USBDevice,
  type: number,
  index: number,
  langId: number,
  length: number,
): Promise<Uint8Array | null> {
  try {
    const result = await dev.controlTransferIn(
      {
        requestType: 'standard',
        recipient: 'device',
        request: 6,
        value: (type << 8) | index,
        index: langId,
      },
      length,
    );
    return result.status === 'ok' ? bytesOf(result.data) : null;
  } catch {
    return null;
  }
}

/** Reads the configuration descriptor for the functional descriptor and name indexes. */
async function readDfuDescriptors(
  dev: USBDevice,
  interfaceNumber: number,
  ctx: FlashContext,
): Promise<DfuDescriptors> {
  const head = await getDescriptor(dev, DESCRIPTOR_CONFIGURATION, 0, 0, 9);
  const total = head && head.length >= 4 ? head[2] | (head[3] << 8) : 0;
  const raw = total > 0 ? await getDescriptor(dev, DESCRIPTOR_CONFIGURATION, 0, 0, total) : null;
  if (!raw) {
    ctx.log('Could not read the USB configuration descriptor; using DFU defaults.');
    return { functional: null, nameIndex: new Map() };
  }
  return parseConfigurationDescriptor(raw, interfaceNumber);
}

/** Reads one string descriptor as text; null when the device refuses. */
async function readStringDescriptor(dev: USBDevice, index: number): Promise<string | null> {
  const raw = await getDescriptor(dev, DESCRIPTOR_STRING, index, LANG_EN_US, 255);
  if (!raw || raw.length < 2 || raw[1] !== DESCRIPTOR_STRING) return null;
  const end = Math.min(raw[0], raw.length);
  let text = '';
  for (let p = 2; p + 1 < end; p += 2) text += String.fromCharCode(raw[p] | (raw[p + 1] << 8));
  return text;
}
