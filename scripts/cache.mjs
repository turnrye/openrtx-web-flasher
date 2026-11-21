// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Where build-time downloads are kept, and how they are retried.
 *
 * Everything the build fetches from the network (the pinned third-party parts, the
 * Emscripten toolchain, firmware) is stored in one directory per user, outside the
 * checkout, so every clone and worktree shares it and a rebuild needs no network:
 *
 *   $ORTX_CACHE, or $XDG_CACHE_HOME/openrtx-web-flasher, or ~/.cache/openrtx-web-flasher
 *
 * It is a cache: deleting it only costs a download. CI saves and restores the same
 * directory between runs.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The directory downloads are kept in. */
export function cacheDir() {
  if (process.env.ORTX_CACHE) return process.env.ORTX_CACHE;
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'openrtx-web-flasher');
}

/**
 * Runs `task` until it succeeds, waiting longer after each failure. `task` may throw an
 * error with `permanent = true` to say that trying again is pointless (a 404, a bad
 * checksum).
 */
export async function retry(what, task, attempts = 5) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await task();
    } catch (error) {
      last = error;
      if (error.permanent || attempt === attempts) break;
      const wait = 2000 * 2 ** (attempt - 1);
      console.warn(`${what}: ${error.message.split('\n')[0]}; trying again in ${wait / 1000} s`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw last;
}

/** Fetches `url` and returns its bytes; HTTP errors that will not go away are permanent. */
export async function download(url, headers = {}) {
  return retry(url, async () => {
    const response = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(120_000) });
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} for ${url}`);
      error.permanent = [400, 401, 404, 410].includes(response.status);
      throw error;
    }
    return new Uint8Array(await response.arrayBuffer());
  });
}
