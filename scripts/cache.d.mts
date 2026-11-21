// SPDX-License-Identifier: GPL-3.0-or-later
/** Types of cache.mjs, for the TypeScript that shares the per-user cache (the command line). */

/** The directory downloads are kept in. */
export function cacheDir(): string;

/** Runs `task` until it succeeds, waiting longer after each failure. */
export function retry<T>(what: string, task: () => T | Promise<T>, attempts?: number): Promise<T>;

/** Fetches `url` and returns its bytes; HTTP errors that will not go away are permanent. */
export function download(url: string, headers?: Record<string, string>): Promise<Uint8Array>;
