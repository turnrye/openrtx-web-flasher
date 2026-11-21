// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  DfuDevice,
  DfuState,
  STM32F405_LAYOUT,
  STM32H743_LAYOUT,
  dfuseCommandBytes,
  fallbackLayout,
  parseMemoryLayout,
  sectorsTouched,
} from './dfu.ts';
import { FlashError, quietContext } from './types.ts';
import { SimStm32Dfu, type SimStm32Options } from '../sim/stm32dfu.ts';

/** A simulated ROM bootloader and a DfuDevice opened on it, sleeping on the sim's clock. */
async function openSim(options: SimStm32Options = {}) {
  const sim = new SimStm32Dfu(options);
  const logs: string[] = [];
  const ctx = quietContext({ sleep: sim.sleep, log: (m) => logs.push(m) });
  const dfu = await DfuDevice.open(sim, ctx);
  return { sim, dfu, logs };
}

describe('DfuSe memory layout', () => {
  it('parses the STM32F405 layout string', () => {
    const layout = parseMemoryLayout('@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg');
    expect(layout).toEqual(STM32F405_LAYOUT);
    expect(layout).toHaveLength(12);
    expect(layout?.[4]).toEqual({
      start: 0x08010000,
      size: 0x10000,
      readable: true,
      erasable: true,
      writable: true,
    });
    expect(layout?.[11].start).toBe(0x080e0000);
  });

  it('parses the STM32H743 layout string', () => {
    expect(parseMemoryLayout('@Internal Flash   /0x08000000/16*128Kg')).toEqual(STM32H743_LAYOUT);
  });

  it('parses several regions, byte and megabyte units and access flags', () => {
    const layout = parseMemoryLayout('@Mixed /0x1FFF7800/01*512 e,01*016 e/0x90000000/02*001Ma');
    expect(layout).toEqual([
      { start: 0x1fff7800, size: 512, readable: true, erasable: false, writable: true },
      { start: 0x1fff7a00, size: 16, readable: true, erasable: false, writable: true },
      { start: 0x90000000, size: 0x100000, readable: true, erasable: false, writable: false },
      { start: 0x90100000, size: 0x100000, readable: true, erasable: false, writable: false },
    ]);
  });

  it('returns null for names without a layout', () => {
    expect(parseMemoryLayout('STM32  BOOTLOADER')).toBeNull();
    expect(parseMemoryLayout('@Internal Flash /0x08000000/garbage')).toBeNull();
    expect(parseMemoryLayout('@Internal Flash /08000000/04*016Kg')).toBeNull();
    expect(parseMemoryLayout('')).toBeNull();
  });

  it('has the built-in layouts of both chips', () => {
    const size = (chip: 'f405' | 'h743') => fallbackLayout(chip).reduce((sum, s) => sum + s.size, 0);
    expect(size('f405')).toBe(1024 * 1024);
    expect(size('h743')).toBe(2 * 1024 * 1024);
    expect(fallbackLayout('f405').map((s) => s.size / 1024)).toEqual([
      16, 16, 16, 16, 64, 128, 128, 128, 128, 128, 128, 128,
    ]);
  });

  it('finds exactly the sectors a range touches', () => {
    const starts = (address: number, length: number) =>
      sectorsTouched(STM32F405_LAYOUT, address, length).map((s) => s.start);
    expect(starts(0x08000000, 1)).toEqual([0x08000000]);
    expect(starts(0x08000000, 0x4000)).toEqual([0x08000000]);
    expect(starts(0x08000000, 0x4001)).toEqual([0x08000000, 0x08004000]);
    expect(starts(0x0800c000, 0x38d70)).toEqual([0x0800c000, 0x08010000, 0x08020000, 0x08040000]);
    expect(starts(0x0800ffff, 2)).toEqual([0x0800c000, 0x08010000]);
    expect(starts(0x080e0000, 0x20000)).toEqual([0x080e0000]);
  });

  it('refuses a range that leaves the flash', () => {
    expect(() => sectorsTouched(STM32F405_LAYOUT, 0x080e0000, 0x20001)).toThrow(FlashError);
    expect(() => sectorsTouched(STM32F405_LAYOUT, 0x07ffffff, 2)).toThrow(/outside its flash/);
    expect(() => sectorsTouched(STM32F405_LAYOUT, 0x20000000, 16)).toThrow(FlashError);
  });
});

describe('DfuDevice on a simulated STM32 ROM', () => {
  it('opens, claims and reads the descriptors', async () => {
    const { sim, dfu } = await openSim();
    expect(sim.opened).toBe(true);
    expect(sim.configuration?.interfaces[0].claimed).toBe(true);
    expect(dfu.alternateSetting).toBe(0);
    expect(dfu.functional).toEqual({
      attributes: 0x0b,
      detachTimeout: 255,
      transferSize: 2048,
      dfuVersion: 0x011a,
    });
    expect(dfu.layout).toEqual(STM32F405_LAYOUT);
    await dfu.close();
    expect(sim.opened).toBe(false);
  });

  it('selects the "@Internal Flash" alternate setting wherever it is', async () => {
    const { sim, dfu } = await openSim({
      alternateNames: [
        '@Option Bytes  /0x1FFFC000/01*016 e',
        '@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg',
      ],
    });
    expect(dfu.alternateSetting).toBe(1);
    expect(sim.configuration?.interfaces[0].alternate.alternateSetting).toBe(1);
    expect(dfu.layout).toEqual(STM32F405_LAYOUT);
  });

  it('falls back to alternate 0 when no setting is named "@Internal Flash"', async () => {
    const { dfu } = await openSim({ alternateNames: [null, '@Something Else /0x00000000/01*004Kg'] });
    expect(dfu.alternateSetting).toBe(0);
    expect(dfu.interfaceName).toBeNull();
    expect(dfu.layout).toBeNull();
  });

  it('reads the layout from string descriptors when WebUSB gives no interface names', async () => {
    const { dfu } = await openSim({ chip: 'h743', exposeInterfaceNames: false });
    expect(dfu.interfaceName).toBe('@Internal Flash   /0x08000000/16*128Kg');
    expect(dfu.layout).toEqual(STM32H743_LAYOUT);
    expect(dfu.functional?.transferSize).toBe(1024);
  });

  it('copes with a device that serves no descriptors', async () => {
    const { dfu, logs } = await openSim({ exposeInterfaceNames: false, serveDescriptors: false });
    expect(dfu.functional).toBeNull();
    expect(dfu.layout).toBeNull();
    expect(logs.join('\n')).toMatch(/configuration descriptor/);
  });

  it('refuses a device without a DFU interface', async () => {
    const serial = {
      opened: true,
      configuration: {
        interfaces: [
          {
            interfaceNumber: 0,
            alternates: [{ alternateSetting: 0, interfaceClass: 0x0a, interfaceSubclass: 0 }],
          },
        ],
      },
    } as unknown as USBDevice;
    await expect(DfuDevice.open(serial, quietContext())).rejects.toThrow(/no DFU interface/);
  });

  it('reports state and status', async () => {
    const { dfu } = await openSim();
    expect(await dfu.getState()).toBe(DfuState.dfuIDLE);
    expect(await dfu.getStatus()).toEqual({ status: 0, pollTimeout: 0, state: DfuState.dfuIDLE });
  });

  it('erases, writes and reads back, honouring bwPollTimeout', async () => {
    const { sim, dfu } = await openSim();
    sim.load(0x08004000, new Uint8Array(0x4000));
    await dfu.eraseSector(0x08004000);
    expect(sim.clock).toBe(0x4000 >> 7); // slept the erase's poll timeout
    expect(sim.read(0x08004000, 0x4000).every((b) => b === 0xff)).toBe(true);

    await dfu.setAddress(0x08004000);
    const block = Uint8Array.from({ length: 2048 }, (_, i) => i & 0xff);
    await dfu.writeBlock(2, block, 'test write');
    await dfu.writeBlock(4, block.subarray(0, 100), 'test write'); // block 3 skipped on purpose
    expect(sim.read(0x08004000, 2048)).toEqual(block);
    expect(sim.read(0x08004000 + 2048, 2048).every((b) => b === 0xff)).toBe(true);
    expect(sim.read(0x08004000 + 4096, 100)).toEqual(block.subarray(0, 100));

    await dfu.abortToIdle();
    expect(await dfu.upload(2, 2048)).toEqual(block);
    expect(await dfu.getState()).toBe(DfuState.dfuUPLOAD_IDLE);
    expect(await dfu.upload(4, 100)).toEqual(block.subarray(0, 100));
    expect(await dfu.getState()).toBe(DfuState.dfuIDLE); // short frame ends the upload
    expect(sim.violations).toEqual([]);
  });

  it('sends DfuSe commands as opcode plus little-endian address', () => {
    expect([...dfuseCommandBytes(0x21, 0x0800c000)]).toEqual([0x21, 0x00, 0xc0, 0x00, 0x08]);
    expect([...dfuseCommandBytes(0x41, 0x081e0000)]).toEqual([0x41, 0x00, 0x00, 0x1e, 0x08]);
  });

  it('turns a write to unerased flash into a FlashError and recovers', async () => {
    const { sim, dfu } = await openSim();
    sim.load(0x08000000, Uint8Array.of(0x12, 0x34));
    await dfu.setAddress(0x08000000);
    await expect(dfu.writeBlock(2, Uint8Array.of(1, 2, 3, 4), 'write at 0x08000000')).rejects.toThrow(
      /error during write at 0x08000000: errVENDOR/,
    );
    expect(sim.violations).toEqual(['write to unerased flash at 0x8000000']);
    expect(sim.read(0x08000000, 2)).toEqual(Uint8Array.of(0x12, 0x34));
    expect(await dfu.getState()).toBe(DfuState.dfuIDLE); // the error was cleared
  });

  it('reports errors for addresses outside the flash', async () => {
    const { dfu } = await openSim();
    await expect(dfu.setAddress(0x20000000)).rejects.toThrow(/set address 0x20000000: errTARGET/);
    await expect(dfu.eraseSector(0x08100000)).rejects.toThrow(/erase of sector 0x08100000: errTARGET/);
  });

  it('gets back to dfuIDLE from dfuERROR and from a download', async () => {
    const { sim, dfu } = await openSim();
    await expect(dfu.download(1, Uint8Array.of(0))).rejects.toThrow(/refused DFU DNLOAD \(stall\)/);
    expect(await dfu.getState()).toBe(DfuState.dfuERROR);
    await dfu.abortToIdle();
    expect(await dfu.getState()).toBe(DfuState.dfuIDLE);
    await dfu.setAddress(0x08000000);
    expect(await dfu.getState()).toBe(DfuState.dfuDNLOAD_IDLE);
    await dfu.abortToIdle();
    expect(await dfu.getState()).toBe(DfuState.dfuIDLE);
    expect(sim.requests.slice(-4)).toEqual(['GETSTATUS', 'ABORT', 'GETSTATUS', 'GETSTATE']);
  });

  it('wraps USB failures in a FlashError', async () => {
    const { sim, dfu } = await openSim();
    await sim.close();
    await expect(dfu.getStatus()).rejects.toThrow(FlashError);
    await expect(dfu.getStatus()).rejects.toThrow(/USB GETSTATUS failed/);
  });
});

describe('the simulated ROM is strict', () => {
  it('fails a host that does not wait bwPollTimeout', async () => {
    const sim = new SimStm32Dfu();
    const dfu = await DfuDevice.open(sim, quietContext()); // quietContext never advances the clock
    await expect(dfu.eraseSector(0x08000000)).rejects.toThrow(FlashError);
    expect(sim.violations[0]).toMatch(/before bwPollTimeout passed/);
  });

  it('fails UPLOAD outside dfuIDLE, oversized blocks and CLRSTATUS without an error', async () => {
    const { sim, dfu } = await openSim();
    await dfu.setAddress(0x08000000);
    await expect(dfu.upload(2, 16)).rejects.toThrow(/refused DFU UPLOAD/);
    await dfu.abortToIdle();
    await expect(dfu.download(2, new Uint8Array(2049))).rejects.toThrow(/refused DFU DNLOAD/);
    await dfu.abortToIdle();
    await expect(dfu.clearStatus()).rejects.toThrow(/refused DFU CLRSTATUS/);
    expect(sim.violations).toHaveLength(3);
  });

  it('refuses flash access on the wrong alternate setting', async () => {
    const { sim, dfu } = await openSim();
    await sim.selectAlternateInterface(0, 1);
    await expect(dfu.eraseSector(0x08000000)).rejects.toThrow(/errTARGET/);
  });

  it('rejects transfers on an unclaimed interface', async () => {
    const sim = new SimStm32Dfu();
    await sim.open();
    const setup = { requestType: 'class', recipient: 'interface', request: 5, value: 0, index: 0 } as const;
    await expect(sim.controlTransferIn(setup, 1)).rejects.toThrow(/not been claimed/);
  });
});
