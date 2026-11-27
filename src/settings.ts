// SPDX-License-Identifier: GPL-3.0-or-later
/** Per-browser settings. Storage can be blocked, so every access is guarded. */

const KEYS = {
  experimental: 'ortx-flasher.experimental',
  repo: 'ortx-flasher.repo',
  introFolded: 'ortx-flasher.intro-folded',
  runs: 'ortx-flasher.runs',
  flashed: 'ortx-flasher.flashed',
} as const;

/** Reads a stored string, or null when missing or storage is unavailable. */
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Stores a string; null removes it. Failures are ignored. */
function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private windows and blocked site data: the setting just does not persist.
  }
}

/** Reads a stored table of values by name; empty when missing or not what was stored. */
function readTable<T>(key: string): Record<string, T> {
  try {
    const table: unknown = JSON.parse(read(key) ?? '{}');
    return table !== null && typeof table === 'object' && !Array.isArray(table)
      ? (table as Record<string, T>)
      : {};
  } catch {
    return {};
  }
}

/** Sets one entry of a stored table; null removes the entry. */
function writeEntry<T>(key: string, name: string, value: T | null): void {
  const table = readTable<T>(key);
  if (value === null) delete table[name];
  else table[name] = value;
  write(key, Object.keys(table).length > 0 ? JSON.stringify(table) : null);
}

/** Whether the user turned on in-browser flashing for radios not yet checked on hardware. */
export const experimental = {
  get: (): boolean => read(KEYS.experimental) === '1',
  set: (on: boolean): void => write(KEYS.experimental, on ? '1' : null),
};

/** Last repository the user looked builds up in. */
export const lastRepo = {
  get: (): string => read(KEYS.repo) ?? '',
  set: (repo: string): void => write(KEYS.repo, repo.trim() || null),
};

/** Whether the user folded the "Before you start" block away. */
export const introFolded = {
  get: (): boolean => read(KEYS.introFolded) === '1',
  set: (folded: boolean): void => write(KEYS.introFolded, folded ? '1' : null),
};

/** What a radio runs when it comes to the page: its maker's firmware, or OpenRTX already. */
export type Runs = 'original' | 'openrtx';

/** What the user last said a radio model runs, by the model's target name. */
export const runsNow = {
  get: (radio: string): Runs | null => {
    const said = readTable<unknown>(KEYS.runs)[radio];
    return said === 'original' || said === 'openrtx' ? said : null;
  },
  set: (radio: string, runs: Runs | null): void => writeEntry(KEYS.runs, radio, runs),
};

/** A flash this browser finished. */
export interface Flashed {
  /** The build's short name: "v0.4.5", "PR #588". */
  label: string;
  /** The commit the build was made from, when the build says. */
  sha?: string;
  /** When the flash finished, ISO 8601. */
  at: string;
  /** The ID of the radio, when a backup had read it in the same visit. */
  radioId?: string;
}

/**
 * What was last flashed from this browser, by radio model and, where the radio's ID is
 * known, by that ID as well. Kept here and nowhere else.
 */
export const lastFlashed = {
  /** The last flash onto one radio (by its ID), or onto any radio of a model. */
  get: (radio: string, radioId?: string | null): Flashed | null => {
    const found = readTable<Partial<Flashed>>(KEYS.flashed)[radioId ? `${radio}:${radioId}` : radio];
    return found && typeof found.label === 'string' && typeof found.at === 'string'
      ? (found as Flashed)
      : null;
  },
  set: (radio: string, flashed: Flashed): void => {
    writeEntry(KEYS.flashed, radio, flashed);
    if (flashed.radioId) writeEntry(KEYS.flashed, `${radio}:${flashed.radioId}`, flashed);
  },
};
