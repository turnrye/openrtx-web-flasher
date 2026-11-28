// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The backups this browser holds, for every radio model: save a copy again, restore the
 * ones the page can write back, forget the ones no longer wanted.
 */
import { useState } from 'preact/hooks';
import type { BackupRecord, BackupStore } from '../backup/store.ts';
import { saveFile } from '../firmware/builds.ts';
import { lastFlashed } from '../settings.ts';
import { shortId } from './BackupStep.tsx';
import { shortCommit } from './BuildFacts.tsx';
import { formatDate, formatSize } from './common.tsx';

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
    <section
      class="flex flex-col gap-3 rounded-box border border-separator p-4 sm:p-5"
      id="backups"
      aria-labelledby="backups-title"
      data-testid="stored-backups"
    >
      <h2 class="text-lg font-medium" id="backups-title">
        Backups in this browser
      </h2>
      <ul class="list rounded-box bg-base-200 p-0">
        {records.map((record) => {
          // Only a radio with an ID can be told from another of its model.
          const id = record.manifest.radioId;
          const flashed = id ? lastFlashed.get(record.manifest.radio, id) : null;
          return (
            <li
              key={record.name}
              class="list-row flex flex-wrap items-center gap-x-4 gap-y-2"
              data-testid="stored-backup"
            >
              <div class="min-w-0 flex-1 basis-64">
                <div class="font-medium">{record.manifest.model}</div>
                <div class="text-sm text-base-content/80">
                  {formatDate(record.manifest.taken)} · radio {shortId(record.manifest.radioId)} ·{' '}
                  {formatSize(record.size)}
                </div>
                {flashed && (
                  <div class="text-sm text-base-content/80" data-testid="stored-flashed">
                    Last flashed here: {flashed.label}
                    {flashed.sha ? ` (${shortCommit(flashed.sha)})` : ''}, {formatDate(flashed.at)}
                  </div>
                )}
              </div>
              <div class="flex flex-wrap items-center gap-1">
                <button
                  class="btn btn-ghost btn-sm"
                  type="button"
                  data-testid="stored-save"
                  onClick={() => void download(record.name)}
                >
                  Save a copy
                </button>
                {record.restorable && (
                  <button
                    class="btn btn-ghost btn-sm"
                    type="button"
                    data-testid="stored-restore"
                    disabled={busy}
                    onClick={() => onRestore(record.name)}
                  >
                    Restore
                  </button>
                )}
                <button
                  class={`btn btn-sm ${forgetting === record.name ? 'btn-warning' : 'btn-ghost'}`}
                  type="button"
                  data-testid="stored-forget"
                  disabled={busy}
                  onClick={() => void forget(record.name)}
                >
                  {forgetting === record.name ? 'Really forget it?' : 'Forget'}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <p class="text-sm text-muted">
        Copies kept by this browser. They go when its site data is cleared and do not follow you to another
        computer: the downloaded file is the backup. Only restore a backup onto the radio it came from.
      </p>
    </section>
  );
}
