// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The backups this browser holds, for every radio model: save a copy again, restore the
 * ones the page can write back, forget the ones no longer wanted.
 */
import { useState } from 'preact/hooks';
import type { BackupRecord, BackupStore } from '../backup/store.ts';
import { saveFile } from '../firmware/builds.ts';
import { formatDate, formatSize } from './common.tsx';
import { shortId } from './BackupStep.tsx';

interface Props {
  store: BackupStore;
  /** Every backup the browser holds, newest first. */
  records: BackupRecord[];
  /** The list changed: load it again. */
  onChanged: () => void;
  /** Chooses a backup as the firmware to flash onto the radio it came from. */
  onRestore: (name: string) => void;
  /** True while a radio is being read or written: nothing here may change what is flashed. */
  busy: boolean;
}

/** The list of stored backups. */
export function BackupsSection({ store, records, onChanged, onRestore, busy }: Props) {
  const [forgetting, setForgetting] = useState('');

  /** Downloads a stored backup again. */
  const download = async (name: string) => {
    const stored = await store.get(name);
    if (stored) saveFile(stored.name, stored.zip);
  };

  /** Removes a stored backup after the second click. */
  const forget = async (name: string) => {
    if (forgetting !== name) return setForgetting(name);
    await store.remove(name);
    setForgetting('');
    onChanged();
  };

  return (
    <div class="block" data-testid="stored-backups">
      <ul class="stored">
        {records.map((record) => (
          <li key={record.name} class="stored-row" data-testid="stored-backup">
            <span>
              {record.manifest.model} · {formatDate(record.manifest.taken)} · radio{' '}
              {shortId(record.manifest.radioId)} · {formatSize(record.size)}
            </span>
            <span class="stored-actions">
              <button
                class="linkish"
                type="button"
                data-testid="stored-save"
                onClick={() => void download(record.name)}
              >
                Save a copy
              </button>
              {record.restorable && (
                <button
                  class="linkish"
                  type="button"
                  data-testid="stored-restore"
                  disabled={busy}
                  onClick={() => onRestore(record.name)}
                >
                  Restore
                </button>
              )}
              <button
                class="linkish"
                type="button"
                data-testid="stored-forget"
                disabled={busy}
                onClick={() => void forget(record.name)}
              >
                {forgetting === record.name ? 'Really forget it?' : 'Forget'}
              </button>
            </span>
          </li>
        ))}
      </ul>
      <p class="muted small">
        Copies kept by this browser. They go when its site data is cleared and do not follow you to another
        computer: the downloaded file is the backup. Only restore a backup onto the radio it came from.
      </p>
    </div>
  );
}
