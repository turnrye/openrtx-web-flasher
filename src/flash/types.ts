// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Shared types for the flashers. A flasher is a plain async function that takes an
 * already-chosen device (WebUSB, Web Serial or WebHID object), the firmware bytes and a
 * FlashContext. It never touches `navigator`, so the same code runs against the
 * simulators in src/sim.
 */

/** What the flasher is doing right now. */
export type Phase = 'connect' | 'read' | 'erase' | 'write' | 'verify' | 'done';

/** Progress report: `done` of `total` bytes (or steps) in `phase`. */
export interface Progress {
  phase: Phase;
  done: number;
  total: number;
}

/** Callbacks a flasher uses to talk to the page. */
export interface FlashContext {
  /** One human-readable log line. */
  log(message: string): void;
  /** Progress update; called often, must be cheap. */
  progress(p: Progress): void;
  /** Sleep, injectable so simulator tests run without real delays. */
  sleep(ms: number): Promise<void>;
}

/** One block of bytes and the flash address it belongs at. */
export interface Segment {
  address: number;
  data: Uint8Array;
}

/** Error with a message that is safe to show to the user as-is. */
export class FlashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlashError';
  }
}

/** Text of a thrown value. */
export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * A backup was not written because the radio that is connected is not the one it was
 * read from. Nothing was written to that radio.
 */
export class WrongRadioError extends FlashError {
  constructor(message: string) {
    super(message);
    this.name = 'WrongRadioError';
  }
}

/** FlashContext that discards output; handy in tests. */
export function quietContext(overrides: Partial<FlashContext> = {}): FlashContext {
  return {
    log: () => {},
    progress: () => {},
    sleep: () => Promise.resolve(),
    ...overrides,
  };
}
