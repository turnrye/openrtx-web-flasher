// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Backups kept in this browser: a second copy of each bundle and a record of which
 * radios have been backed up.
 *
 * It is a convenience and a safety net, never the only copy: a browser can clear site
 * storage, and the copy does not follow the user to another browser or computer. The
 * file is always handed to the user as a download first. Nothing here leaves the
 * browser.
 *
 * Storage is shared by every page on the same address (on <owner>.github.io that
 * includes the owner's other project pages), which is another reason not to treat it as
 * a vault. Simulated radios (`?sim=`) get a store of their own.
 */
import type { BundleManifest } from './bundle.ts';

/** One backup as the store keeps it. */
export interface StoredBackup {
  /** The bundle's file name; also its key. */
  name: string;
  manifest: BundleManifest;
  /** Whether the page can write this backup back to the radio. */
  restorable: boolean;
  /** Size of the zip in bytes. */
  size: number;
  zip: Uint8Array;
}

/** A stored backup without its bytes, for listing. */
export type BackupRecord = Omit<StoredBackup, 'zip'>;

const STORE = 'backups';

/** Opens (and on first use creates) the database; null where IndexedDB is unavailable. */
function open(simulated: boolean): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(simulated ? 'openrtx-flasher-sim' : 'openrtx-flasher', 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'name' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      // Private windows and blocked site data: carry on without a store.
      resolve(null);
    }
  });
}

/** Runs one request against the store and resolves with its result, or `fallback` on any failure. */
async function run<T>(
  simulated: boolean,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest,
  fallback: T,
): Promise<T> {
  const db = await open(simulated);
  if (!db) return fallback;
  try {
    return await new Promise<T>((resolve) => {
      const transaction = db.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve((request.result as T | undefined) ?? fallback);
      transaction.onerror = () => resolve(fallback);
      transaction.onabort = () => resolve(fallback);
    });
  } catch {
    return fallback;
  } finally {
    db.close();
  }
}

/** A store for real radios or, with `simulated`, for simulated ones. */
export function backupStore(simulated: boolean) {
  return {
    /** Keeps a copy of a bundle. Resolves to false when the browser would not store it. */
    async save(backup: StoredBackup): Promise<boolean> {
      // Ask the browser not to evict the data under storage pressure; it may say no.
      void navigator.storage?.persist?.().catch(() => false);
      const key = await run<IDBValidKey | null>(simulated, 'readwrite', (store) => store.put(backup), null);
      return key !== null;
    },

    /** Records of every backup kept, newest first, without their bytes. */
    async list(): Promise<BackupRecord[]> {
      const all = await run<StoredBackup[]>(simulated, 'readonly', (store) => store.getAll(), []);
      return all
        .map(({ zip: _zip, ...record }) => record)
        .sort((a, b) => b.manifest.taken.localeCompare(a.manifest.taken));
    },

    /** One backup with its bytes, or null. */
    get(name: string): Promise<StoredBackup | null> {
      return run<StoredBackup | null>(simulated, 'readonly', (store) => store.get(name), null);
    },

    /** Forgets a backup. */
    async remove(name: string): Promise<void> {
      await run<undefined>(simulated, 'readwrite', (store) => store.delete(name), undefined);
    },
  };
}

/** The store type, for passing around. */
export type BackupStore = ReturnType<typeof backupStore>;
