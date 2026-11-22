// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Flasher for the TYT vendor bootloader of the MD-380, MD-UV380/390, MD-9600 and
 * DM-1701 (USB 0483:df11, "Digital Radio in USB mode"), and a reader for the wrapped
 * firmware files it takes.
 *
 * This is a port of radio_tool (https://github.com/v0l/radio_tool, Copyright (c) 2020 v0l,
 * GPL-3.0-or-later; its C++ sources as of commit e0a01ce4):
 * the file layout and model table come from tyt_fw.cpp / tyt_fw.hpp, the flashing
 * sequence from tyt_radio.cpp, the vendor command from tyt_dfu.cpp, the request
 * pattern around each DNLOAD from dfu.cpp and the sector walk from util/flash.hpp.
 * The radio is sent exactly what radio_tool sends, in the same order.
 */
import { DfuDevice, DfuSeCommand, DfuState, dfuStateName, dfuseCommandBytes, hex32 } from './dfu.ts';
import { FlashError, type FlashContext, type Segment } from './types.ts';

const HEADER_SIZE = 0x100;
const REGION_TABLE_OFFSET = 0x80;
const MAX_REGIONS = 16;
/** "OutSecurityBin" plus two NULs. */
const START_MAGIC = [
  0x4f, 0x75, 0x74, 0x53, 0x65, 0x63, 0x75, 0x72, 0x69, 0x74, 0x79, 0x42, 0x69, 0x6e, 0, 0,
];

/** Bytes per DNLOAD, fixed by the bootloader. */
const TRANSFER_SIZE = 1024;
/** TYT vendor command prefix and the "firmware upgrade" command. */
const TYT_CUSTOM_COMMAND = 0x91;
const TYT_FIRMWARE_UPGRADE = 0x31;
/** GETSTATE/ABORT rounds before giving up; radio_tool loops for ever here. */
const MAX_INIT_ROUNDS = 10;

/** Radio models by the "counter magic" in the file header (radio_tool's tyt::config). */
const MODELS: readonly { radio: string; magic: readonly number[] }[] = [
  { radio: 'MD2017', magic: [0x02, 0x19, 0x0c] },
  { radio: 'MD2017 GPS', magic: [0x02, 0x18, 0x0c] },
  { radio: 'MD2017', magic: [0x01, 0x19] },
  { radio: 'MD2017 GPS', magic: [0x01, 0x18] },
  { radio: 'MD9600', magic: [0x01, 0x14] },
  { radio: 'UV3X0 GPS', magic: [0x02, 0x16, 0x0c] },
  { radio: 'UV3X0', magic: [0x02, 0x17, 0x0c] },
  { radio: 'DM1701', magic: [0x01, 0x0f] },
  { radio: 'MD390', magic: [0x01, 0x10] },
  { radio: 'MD380', magic: [0x01, 0x0d] },
  { radio: 'MD280', magic: [0x01, 0x1b] },
];

/** STM32F40x sector sizes from 0x08000000, as in radio_tool's flash::STM32F40X. */
const F40X_BASE = 0x08000000;
const F40X_SECTOR_SIZES = [
  0x4000, 0x4000, 0x4000, 0x4000, 0x10000, 0x20000, 0x20000, 0x20000, 0x20000, 0x20000, 0x20000, 0x20000,
];

/** A parsed TYT firmware file. */
export interface TytFirmware {
  /** Radio model the file is for, from its counter magic: "UV3X0", "MD380", "DM1701"... */
  radio: string;
  /** Model string stored in the header: "MD-9600", "JST51", "DM1701". */
  firmwareModel: string;
  /** Regions to write, still encrypted as stored in the file. */
  segments: Segment[];
}

/** The part of one flash sector that a region covers. */
interface SectorSpan {
  address: number;
  size: number;
  sectorStart: number;
}

/**
 * Parses a TYT-wrapped firmware file: 0x100-byte header with the "OutSecurityBin"
 * magic and the region table, then the data. Throws FlashError on anything else.
 */
export function parseTytFirmware(bytes: Uint8Array): TytFirmware {
  const bad = (why: string) => new FlashError(`Not a valid TYT firmware file: ${why}.`);
  if (bytes.length < HEADER_SIZE) throw bad('it is too short');
  if (START_MAGIC.some((b, i) => bytes[i] !== b)) throw bad('the "OutSecurityBin" magic is missing');

  const counter = bytes.subarray(0x30, 0x7c);
  if (counter[0] > 3) throw bad('the counter magic length is wrong');
  const model = MODELS.find((m) => m.magic.every((b, i) => counter[i] === b));
  if (!model) throw bad('it is for a radio model that is not supported');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let regions = view.getUint32(0x7c, true);
  if (regions === 0xffffffff) regions = 1; // some stock files leave the count blank
  if (regions > MAX_REGIONS) throw bad('the region count is out of bounds');

  const segments: Segment[] = [];
  let offset = HEADER_SIZE;
  for (let r = 0; r < regions; r++) {
    const address = view.getUint32(REGION_TABLE_OFFSET + r * 8, true);
    const length = view.getUint32(REGION_TABLE_OFFSET + r * 8 + 4, true);
    if (offset + length > bytes.length) throw bad('it is truncated');
    segments.push({ address, data: bytes.slice(offset, offset + length) });
    offset += length;
  }
  if (segments.every((s) => s.data.length === 0)) throw bad('it holds no firmware');

  const name = bytes.subarray(0x10, 0x20);
  const end = name.indexOf(0);
  const firmwareModel = String.fromCharCode(...name.subarray(0, end < 0 ? name.length : end));
  return { radio: model.radio, firmwareModel, segments };
}

/**
 * Splits [start, end) at STM32F40x sector boundaries, like radio_tool's
 * AlignedContiguousMemoryOp. Throws when the range leaves the flash, where radio_tool
 * would silently stop.
 */
function sectorSpans(start: number, end: number): SectorSpan[] {
  const spans: SectorSpan[] = [];
  let sectorStart = F40X_BASE;
  let address = start;
  for (const size of F40X_SECTOR_SIZES) {
    const sectorEnd = sectorStart + size;
    if (address < end && address >= sectorStart && address < sectorEnd) {
      const n = Math.min(end, sectorEnd) - address;
      spans.push({ address, size: n, sectorStart });
      address += n;
    }
    sectorStart = sectorEnd;
  }
  if (address < end) {
    throw new FlashError(
      `The firmware does not fit the radio: ${hex32(address)} is outside its flash memory.`,
    );
  }
  return spans;
}

/**
 * radio_tool's DFU::InitDownload: GETSTATE until dfuIDLE or dfuDNLOAD-IDLE, sending
 * ABORT otherwise. Unlike radio_tool it clears dfuERROR (ABORT cannot) and gives up
 * after a few rounds.
 */
async function initDownload(dfu: DfuDevice): Promise<void> {
  let state = -1;
  for (let round = 0; round < MAX_INIT_ROUNDS; round++) {
    state = await dfu.getState();
    if (state === DfuState.dfuIDLE || state === DfuState.dfuDNLOAD_IDLE) return;
    if (state === DfuState.dfuERROR) await dfu.clearStatus();
    else await dfu.abort();
  }
  throw new FlashError(
    `The radio is stuck in DFU state ${dfuStateName(state)}. Restart it in bootloader mode.`,
  );
}

/**
 * radio_tool's DFU::Download: GETSTATE, DNLOAD, GETSTATUS expecting dfuDNBUSY, then
 * GETSTATUS expecting dfuDNLOAD-IDLE. Like radio_tool it does not wait bwPollTimeout;
 * the radio holds off the second GETSTATUS until it is done.
 */
async function tytDownload(dfu: DfuDevice, data: Uint8Array, blockNum: number, what: string) {
  await initDownload(dfu);
  await dfu.download(blockNum, data);
  const busy = await dfu.getStatus();
  if (busy.state !== DfuState.dfuDNBUSY) {
    throw new FlashError(`The radio rejected the ${what} (DFU state ${dfuStateName(busy.state)}).`);
  }
  const done = await dfu.getStatus();
  if (done.state !== DfuState.dfuDNLOAD_IDLE) {
    throw new FlashError(`The radio failed the ${what} (DFU state ${dfuStateName(done.state)}).`);
  }
}

/** Refuses regions that share a flash sector: erasing for the second would wipe the first. */
function checkNoSharedSectors(plan: SectorSpan[][]): void {
  const seen = new Set<number>();
  for (const spans of plan) {
    if (spans.some((s) => seen.has(s.sectorStart))) {
      throw new FlashError(
        'Two regions of this firmware file share a flash sector; it cannot be flashed safely.',
      );
    }
    for (const s of spans) seen.add(s.sectorStart);
  }
}

/**
 * Flashes a TYT-wrapped firmware file through the radio's vendor bootloader, the way
 * radio_tool does: "firmware upgrade" command, then per region erase the sectors it
 * touches and send the stored bytes in 1024-byte blocks. There is no read-back and no
 * reboot command: the user power-cycles the radio afterwards.
 */
/** Where the TYT bootloader's writable flash starts: just past the bootloader itself. */
const BOOTLOADER_FLASH_START = 0x0800c000;

/**
 * Refuses to go on unless the device is a TYT radio in flashing mode.
 *
 * A TYT radio that is merely switched on has the same USB IDs as its bootloader and
 * accepts the same commands, but there erasing and writing are not kept away from the
 * bootloader, which is the one thing on these radios that cannot be put back. The two
 * differ in the layout string of the first DFU interface:
 *
 *   bootloader         @Internal Flash   /0x0800C000/01*016Kg,01*064Kg,07*128Kg
 *   original firmware  @Internal Flash   /0x08000000/03*016Kg
 *
 * (RadioFoundry, hardware-md9600.md 15.1 and hardware-md380.md; measured on radios.)
 * Nothing has been sent to the device when this throws.
 */
function requireUpgradeMode(dfu: DfuDevice): void {
  const start = dfu.layout?.[0]?.start;
  if (start === BOOTLOADER_FLASH_START) return;
  if (start !== undefined) {
    throw new FlashError(
      'The radio is not in flashing mode: it is in normal mode. Nothing was sent to it. ' +
        'Turn it off, hold the keys shown in the flashing mode step, turn it on and try again.',
    );
  }
  throw new FlashError(
    'Could not tell whether the radio is in flashing mode, so nothing was sent to it. ' +
      `(It reported "${dfu.interfaceName ?? 'no layout'}".)`,
  );
}

export async function flashTyt(dev: USBDevice, wrapped: Uint8Array, ctx: FlashContext): Promise<void> {
  const fw = parseTytFirmware(wrapped);
  const plan = fw.segments.map((s) => sectorSpans(s.address, s.address + s.data.length));
  checkNoSharedSectors(plan);
  const total = fw.segments.reduce((sum, s) => sum + s.data.length, 0);

  ctx.progress({ phase: 'connect', done: 0, total });
  const dfu = await DfuDevice.open(dev, ctx);
  try {
    requireUpgradeMode(dfu);
    ctx.log(`Firmware for ${fw.radio} (${fw.firmwareModel}), ${total} bytes.`);
    await tytDownload(
      dfu,
      Uint8Array.of(TYT_CUSTOM_COMMAND, TYT_FIRMWARE_UPGRADE),
      0,
      'firmware upgrade command (is this a TYT radio in bootloader mode?)',
    );

    let erased = 0;
    let written = 0;
    for (const [r, segment] of fw.segments.entries()) {
      const spans = plan[r];
      ctx.progress({ phase: 'erase', done: erased, total });
      for (const span of spans) {
        ctx.log(`Erasing ${hex32(span.address)}, ${span.size} bytes.`);
        const erase = dfuseCommandBytes(DfuSeCommand.ERASE, span.address);
        await tytDownload(dfu, erase, 0, `erase at ${hex32(span.address)}`);
        erased += span.size;
        ctx.progress({ phase: 'erase', done: erased, total });
      }

      // Block numbers restart at 2 in every sector, after a fresh set-address. A block
      // is cut only at the end of the region, never at the end of a sector.
      const data = segment.data;
      let sectorOffset = 0;
      ctx.progress({ phase: 'write', done: written, total });
      for (const span of spans) {
        ctx.log(`Writing ${hex32(span.address)}, ${span.size} bytes.`);
        const setAddress = dfuseCommandBytes(DfuSeCommand.SET_ADDRESS, span.address);
        await tytDownload(dfu, setAddress, 0, `set address ${hex32(span.address)}`);
        const blocks = Math.ceil(span.size / TRANSFER_SIZE);
        for (let i = 0; i < blocks; i++) {
          const offset = sectorOffset + TRANSFER_SIZE * i;
          const chunk = data.subarray(offset, offset + Math.min(TRANSFER_SIZE, data.length - offset));
          await tytDownload(dfu, chunk, 2 + i, `write at ${hex32(segment.address + offset)}`);
          ctx.progress({ phase: 'write', done: written + offset + chunk.length, total });
        }
        sectorOffset += span.size;
      }
      written += data.length;
    }

    ctx.log('Done. This bootloader cannot read the flash back, so the write was not verified.');
    ctx.log('Turn the radio off and on again to start the new firmware.');
    ctx.progress({ phase: 'done', done: total, total });
  } finally {
    await dfu.close();
  }
}
