// SPDX-License-Identifier: GPL-3.0-or-later
/** Per-browser settings. Storage can be blocked, so every access is guarded. */

const KEYS = {
  experimental: 'ortx-flasher.experimental',
  repo: 'ortx-flasher.repo',
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
