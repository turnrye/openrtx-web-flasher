// SPDX-License-Identifier: GPL-3.0-or-later
import { describe as suite, expect, it } from 'vitest';
import { clock, describe, remaining } from './Activity.tsx';

suite('what the page says while it talks to a radio', () => {
  it('shows elapsed time as minutes and seconds', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(7400)).toBe('0:07');
    expect(clock(760_000)).toBe('12:40');
  });

  it('estimates the time left only once there is something to go on', () => {
    expect(remaining(0, 4096, 10_000)).toBe('');
    expect(remaining(100, 4096, 2000)).toBe('');
    expect(remaining(4096, 4096, 60_000)).toBe('');
    // A C62 backup: 4 MiB at about 7 KB a second.
    expect(remaining(70_000, 4_194_304, 10_000)).toBe('about 10 min left');
    expect(remaining(3_500_000, 4_194_304, 500_000)).toBe('about 2 min left');
    expect(remaining(4_000_000, 4_194_304, 570_000)).toBe('under a minute left');
    expect(remaining(3_700_000, 4_194_304, 530_000)).toBe('about a minute left');
  });

  it('says what is happening, how much, and for how long', () => {
    // Connecting has nothing to count yet, but the clock runs.
    expect(describe({ phase: 'connect', done: 0, total: 4_194_304 }, 7000, 7000, 0)).toBe(
      'Connecting to the radio · 0:07 elapsed',
    );
    expect(describe({ phase: 'read', done: 131_072, total: 4_194_304 }, 25_000, 18_000, 0)).toBe(
      'Reading · 128 KB of 4.0 MB · 0:25 elapsed · about 9 min left',
    );
    // Erasing counts sectors, not bytes, so no amount is shown.
    expect(describe({ phase: 'erase', done: 1, total: 4 }, 3000, 1000, 0)).toBe('Erasing · 0:03 elapsed');
    // The estimate is for the current phase, from where that phase began.
    expect(describe({ phase: 'verify', done: 600_000, total: 1_000_000 }, 90_000, 10_000, 500_000)).toBe(
      'Checking what was written · 586 KB of 977 KB · 1:30 elapsed · under a minute left',
    );
  });
});
