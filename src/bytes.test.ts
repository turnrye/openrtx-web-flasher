// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  bytesOf,
  fingerprint,
  fingerprintUnlessBlank,
  hex,
  hexByte,
  hexSpaced,
  same,
  sha256Hex,
} from './bytes.ts';

const ABC = new TextEncoder().encode('abc');
/** SHA-256 of "abc" (FIPS 180-2, appendix B.1). */
const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('byte helpers', () => {
  it('writes hex the three ways the logs and messages use', () => {
    const bytes = Uint8Array.of(0x0a, 0x1b, 0xff);
    expect(hex(bytes)).toBe('0a1bff');
    expect(hexSpaced(bytes)).toBe('0a 1b ff');
    expect(hexByte(0x0a)).toBe('0x0a');
    expect(hex(new Uint8Array(0))).toBe('');
    expect(hexSpaced(new Uint8Array(0))).toBe('');
  });

  it('compares bytes with bytes, with a list of numbers, and with nothing', () => {
    expect(same(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3))).toBe(true);
    expect(same(Uint8Array.of(1, 2, 3), [1, 2, 3])).toBe(true);
    expect(same(Uint8Array.of(1, 2, 3), [1, 2, 4])).toBe(false);
    expect(same(Uint8Array.of(1, 2, 3), [1, 2])).toBe(false);
    expect(same(new Uint8Array(0), undefined)).toBe(false);
  });

  it('hashes what a view covers, not the buffer behind it', async () => {
    const padded = new Uint8Array(8);
    padded.set(ABC, 2);
    expect(await sha256Hex(ABC)).toBe(ABC_SHA256);
    expect(await sha256Hex(padded.subarray(2, 5))).toBe(ABC_SHA256);
    expect(await fingerprint(padded.subarray(2, 5))).toBe(ABC_SHA256.slice(0, 16));
  });

  it('gives no fingerprint for bytes that are all 0xFF or all 0x00', async () => {
    expect(await fingerprintUnlessBlank(new Uint8Array(64).fill(0xff))).toBeNull();
    expect(await fingerprintUnlessBlank(new Uint8Array(64))).toBeNull();
    expect(await fingerprintUnlessBlank(ABC)).toBe(ABC_SHA256.slice(0, 16));
    // The plain one hashes whatever it is given.
    expect(await fingerprint(new Uint8Array(64))).toMatch(/^[0-9a-f]{16}$/);
  });

  it('copies a view out of its buffer', () => {
    const buffer = Uint8Array.of(9, 1, 2, 3, 9).buffer;
    const copy = bytesOf(new DataView(buffer, 1, 3));
    expect([...copy]).toEqual([1, 2, 3]);
    expect(copy.buffer).not.toBe(buffer);
    expect(bytesOf(undefined)).toHaveLength(0);
  });
});
