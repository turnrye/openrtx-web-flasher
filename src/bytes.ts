// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Bytes as text, compared and hashed: the small helpers the flashers, readers and
 * simulators each had a copy of. Where the copies wrote bytes differently, each way has
 * its own name here, so nothing a log, an error or a backup says has changed.
 */

/** Bytes as lower-case hex without separators: "0a1bff". */
export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Bytes as lower-case hex with a space between them, for logs and error messages: "0a 1b ff". */
export function hexSpaced(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

/** One byte as two-digit hex with its prefix, for messages: "0x0a". */
export function hexByte(byte: number): string {
  return `0x${byte.toString(16).padStart(2, '0')}`;
}

/** A DataView's bytes as a Uint8Array of their own; empty for no view. */
export function bytesOf(view: DataView | undefined): Uint8Array {
  if (!view) return new Uint8Array(0);
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
}

/** True when `a` and `b` hold the same bytes; false when there is no `b`. */
export function same(a: ArrayLike<number>, b: ArrayLike<number> | undefined): boolean {
  if (b?.length !== a.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** SHA-256 of `bytes` as lower-case hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)));
}

/**
 * First 16 hex digits of the SHA-256 of `bytes`. For a radio with no ID to read, the
 * fingerprint of its factory calibration stands in for one.
 */
export async function fingerprint(bytes: Uint8Array): Promise<string> {
  return (await sha256Hex(bytes)).slice(0, 16);
}

/**
 * `fingerprint`, or null when the bytes are all 0xFF or all 0x00 and so say nothing
 * about the radio.
 */
export async function fingerprintUnlessBlank(bytes: Uint8Array): Promise<string | null> {
  if (bytes.every((b) => b === 0xff) || bytes.every((b) => b === 0x00)) return null;
  return fingerprint(bytes);
}
