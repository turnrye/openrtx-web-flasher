// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Progress } from '../flash/types.ts';
import { beganWriting } from './FlashStep.tsx';

/** The phases a flasher reported, as the flash step collects them. */
const phases = (...seen: Progress['phase'][]) => new Set(seen);

describe('beganWriting', () => {
  it('says nothing was written when the flash failed before any erase or write', () => {
    expect(beganWriting(phases(), [])).toBe(false);
    expect(beganWriting(phases('connect'), ['Firmware: v0.4.5', 'Failed: the radio did not answer.'])).toBe(
      false,
    );
  });

  it('counts an erase, a write or a check of what was written as a change', () => {
    expect(beganWriting(phases('connect', 'erase'), [])).toBe(true);
    expect(beganWriting(phases('connect', 'write'), [])).toBe(true);
    expect(beganWriting(phases('connect', 'verify'), [])).toBe(true);
  });

  it('counts cskburn naming a partition, which comes before its first amount', () => {
    expect(beganWriting(phases('connect'), ['Entering update mode', 'Burning partition 1/2…'])).toBe(true);
    // A line that only mentions burning is not the burn.
    expect(beganWriting(phases('connect'), ['Waiting before Burning partition 1/2'])).toBe(false);
  });
});
