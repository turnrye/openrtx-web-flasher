// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The backup step. The page reads the radio (in flashing mode where the bootloader can
 * be read, otherwise through the original firmware with the radio in normal mode),
 * hands the result to the browser as a download and keeps a second copy in the browser.
 * The step ends with a backup or with the user skipping it.
 */
import { useEffect, useState } from 'preact/hooks';
import { makeBundle, type BundleManifest } from '../backup/bundle.ts';
import type { BackupRecord, BackupStore } from '../backup/store.ts';
import { isAlready } from '../backup/types.ts';
import { isChooserCancel, type DeviceEnv } from '../devices.ts';
import { saveFile } from '../firmware/builds.ts';
import { backupDevice, type PickedDevice, type Purpose } from '../flash/run.ts';
import type { Progress } from '../flash/types.ts';
import { backupFor, type Radio } from '../radios.ts';
import { Activity, Console, paintGate } from './Activity.tsx';
import { formatDate, formatSize } from './common.tsx';
import { ExperimentalGate } from './Experimental.tsx';
import { CopyReport, ReportLink, ReportNote, type ReportDraft } from './Report.tsx';

/** A backup that was read from the radio in this session. */
export interface SavedBackup {
  name: string;
  zip: Uint8Array;
  manifest: BundleManifest;
  /** Whether the browser also kept a copy. */
  kept: boolean;
}

/** Where backing up the chosen radio stands; the page keeps it while the radio stays chosen. */
export interface BackupState {
  saved: SavedBackup | null;
  /** The user went on without a backup from this page. */
  skipped: boolean;
  /** The backup this browser already held of the radio that is connected, found by its ID. */
  already: BackupRecord | null;
}

/** Nothing backed up, nothing skipped. */
export const NO_BACKUP: BackupState = { saved: null, skipped: false, already: null };

interface Props {
  radio: Radio;
  env: DeviceEnv;
  store: BackupStore;
  /** Whether this browser can talk to this radio at all. */
  supported: boolean;
  /** Whether talking to this radio is allowed: it was checked on hardware, or experimental flashing is on. */
  allowed: boolean;
  onExperimental: () => void;
  /** Returns the device for a purpose, opening the browser's chooser when needed. */
  getDevice: (purpose: Purpose) => Promise<PickedDevice>;
  /** Forgets the device, after an error or when the radio is about to change state. */
  dropDevice: () => void;
  state: BackupState;
  onState: (state: BackupState) => void;
  /** Tells the page the radio is being read, so nothing else starts. */
  onBusy: (busy: boolean) => void;
  /** A backup was kept in the browser. */
  onStored: () => void;
  /** The step is finished: go on. `read` is true when the radio was read just now. */
  onDone: (read: boolean) => void;
  /** Every backup this browser holds, of any model. */
  records: BackupRecord[];
}

/** The last characters of a radio ID, enough to tell two radios apart at a glance. */
export function shortId(id: string | null): string {
  return id ? `…${id.slice(-8)}` : 'no ID';
}

/** The backup step of the page. */
export function BackupStep(props: Props) {
  const { radio, env, store, supported, allowed, getDevice, dropDevice, state, onState, onBusy } = props;
  const backup = backupFor(radio);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress>({ phase: 'connect', done: 0, total: 1 });
  const [error, setError] = useState('');
  /** What the reader logged during the last attempt: shown in the console, and sent with a report. */
  const [log, setLog] = useState<string[]>([]);
  const [startedAt, setStartedAt] = useState(0);

  useEffect(() => setError(''), [radio.id]);

  /** Goes on without a backup from this page. */
  const skip = () => {
    onState({ ...state, skipped: true });
    props.onDone(false);
  };

  if (backup.how !== 'read') {
    return (
      <div class="block" data-testid="backup-copy">
        <p>{backup.text}</p>
        <div class="actions">
          <button class="btn primary" type="button" data-testid="backup-continue" onClick={skip}>
            Continue
          </button>
        </div>
      </div>
    );
  }

  /** The complete backups this browser holds of this model. */
  const stored = props.records.filter(
    (record) => record.manifest.radio === radio.id && record.manifest.parts.every((part) => part.complete),
  );

  /**
   * Reads the radio, hands the bundle to the browser as a download and keeps a copy. The
   * reader first learns which radio it is; when this browser already holds a complete
   * backup of that one, the read stops there, unless `again` asks for a new one.
   */
  const run = async (again = false) => {
    setError('');
    let picked: PickedDevice;
    try {
      picked = await getDevice('backup');
    } catch (e) {
      if (!isChooserCancel(e)) setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setRunning(true);
    onBusy(true);
    setStartedAt(Date.now());
    setProgress({ phase: 'connect', done: 0, total: 1 });
    setLog([]);
    const lines: string[] = [];
    const paint = paintGate();
    try {
      const read = await backupDevice(
        radio,
        picked,
        {
          log: (line) => {
            lines.push(line);
            setLog([...lines]);
          },
          sleep: (ms) => env.sleep(ms),
          progress: (p) => {
            if (paint(p)) setProgress(p);
          },
        },
        env.backupSize?.(radio),
        again ? undefined : (id) => stored.some((record) => record.manifest.radioId === id),
      );
      if (isAlready(read)) {
        const record = stored.find((r) => r.manifest.radioId === read.known)!;
        onState({ saved: null, skipped: false, already: record });
        return;
      }
      const source = backup.mode === 'normal' ? 'original-firmware' : 'flashing-mode';
      const { name, zip, manifest } = await makeBundle(radio, read, source, new Date());
      // Hand the file to the user before anything else can go wrong.
      saveFile(name, zip);
      const kept = await store.save({ name, manifest, restorable: backup.restorable, size: zip.length, zip });
      onState({ saved: { name, zip, manifest, kept }, skipped: false, already: null });
      if (kept) props.onStored();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // The radio is put in its mode again before the next try, which makes it another
      // device to the browser; and a wrong pick must be possible to correct.
      dropDevice();
    } finally {
      // Read in normal mode, the radio restarts or is about to be put in flashing mode:
      // either way it is a different device from here on.
      if (backup.mode === 'normal') dropDevice();
      setRunning(false);
      onBusy(false);
    }
  };

  const saved = state.saved;
  const already = state.already;

  /** Downloads the copy of the backup that was found for this radio. */
  const saveStored = async (name: string) => {
    const copy = await store.get(name);
    if (copy) saveFile(copy.name, copy.zip);
  };
  /** A report of the read that just failed. */
  const failure: ReportDraft = {
    outcome: 'failed',
    step: 'backup',
    radio: { id: radio.id, name: radio.name },
    error,
    log,
  };
  const missing = saved?.manifest.parts.filter((part) => !part.complete) ?? [];
  const retry =
    backup.mode === 'normal'
      ? 'Check that the radio is in normal mode and try again, or skip the backup.'
      : 'Put the radio back in flashing mode and try again, or skip the backup.';

  return (
    <div class="block" data-testid="backup-read">
      <p>
        Save what the radio holds before it is replaced.
        {backup.mode === 'normal' &&
          ' Put the radio in normal mode: switch it on without holding any keys, and connect the programming cable.'}
      </p>
      {backup.notIncluded && (
        <p data-testid="backup-not-included">
          {backup.notIncluded.text} <a href={backup.notIncluded.url}>{backup.notIncluded.label}</a>.
        </p>
      )}

      {!supported ? (
        <div data-testid="backup-needs-browser">
          <p>This browser cannot read this radio.</p>
          {backup.command ? (
            <>
              <p>With the usual tool:</p>
              <pre class="command">{backup.command}</pre>
            </>
          ) : (
            <p>Your programming software can save the channels and settings.</p>
          )}
          <div class="actions">
            <button class="btn" type="button" data-testid="backup-skip" onClick={skip}>
              Continue
            </button>
          </div>
        </div>
      ) : !allowed ? (
        <>
          <ExperimentalGate radio={radio} onTurnOn={props.onExperimental} />
          <div class="actions">
            <button class="linkish" type="button" data-testid="backup-skip" onClick={skip}>
              Skip the backup
            </button>
          </div>
        </>
      ) : (
        <>
          <div class="actions">
            <button
              class={`btn${saved || already ? '' : ' primary'}`}
              type="button"
              disabled={running}
              data-testid="backup"
              onClick={() => void run(!!already || !!saved)}
            >
              {running && <span class="spinner" aria-hidden="true" />}
              {running
                ? 'Reading the radio…'
                : saved
                  ? 'Back up again'
                  : already
                    ? 'Back up again anyway'
                    : 'Back up now'}
            </button>
            {!running && !saved && !already && <span class="muted">{backup.time}</span>}
            {!running && already && backup.endsFlashingMode && (
              <span class="muted">Put the radio in flashing mode again first.</span>
            )}
            {!running && !saved && !already && backup.unchecked && (
              <span class="unchecked" data-testid="backup-unchecked">
                Unchecked on this model
              </span>
            )}
            {running && <span class="muted">Do not unplug or switch off the radio.</span>}
            {!running && !saved && !already && (
              <button class="linkish" type="button" data-testid="backup-skip" onClick={skip}>
                Skip the backup
              </button>
            )}
          </div>
          {already && !running ? (
            // Nothing was read, so there is no progress to show: only what the radio said.
            <Console lines={log} running={false} />
          ) : (
            (running || log.length > 0) && (
              <Activity
                progress={progress}
                running={running}
                failed={!!error}
                log={log}
                startedAt={startedAt}
              />
            )
          )}
          {error && (
            <>
              <p class="error" role="alert" data-testid="backup-error">
                {error} {retry}
              </p>
              <div class="actions">
                <ReportLink report={failure} label="Report this" testid="report-failed" />
                <CopyReport report={failure} />
              </div>
              <ReportNote />
            </>
          )}
          {already && !saved && !running && (
            <div role="status" data-testid="backup-already">
              <p class="ok-text">
                This radio ({shortId(already.manifest.radioId)}) was already backed up in this browser on{' '}
                {formatDate(already.manifest.taken)}, so the page did not read it again.{' '}
                <button
                  class="linkish"
                  type="button"
                  data-testid="backup-save-stored"
                  onClick={() => void saveStored(already.name)}
                >
                  Save a copy of that backup
                </button>
              </p>
              <div class="actions">
                <button
                  class="btn primary"
                  type="button"
                  data-testid="backup-continue"
                  onClick={() => props.onDone(true)}
                >
                  Continue
                </button>
              </div>
            </div>
          )}
          {saved && !running && (
            <div role="status" data-testid="backup-done">
              <p class="ok-text">
                Saved {saved.name} ({formatSize(saved.zip.length)}) to your downloads
                {saved.kept ? ', and kept a copy in this browser' : ''}.{' '}
                <button
                  class="linkish"
                  type="button"
                  data-testid="backup-save-again"
                  onClick={() => saveFile(saved.name, saved.zip)}
                >
                  Save it again
                </button>
              </p>
              <ul class="small">
                <li>Radio ID: {saved.manifest.radioId ?? 'this radio does not report one'}</li>
                {saved.manifest.firmware && <li>Firmware on the radio: {saved.manifest.firmware}</li>}
                {missing.map((part) => (
                  <li key={part.file} class="error">
                    {part.file} is incomplete{part.note ? `: ${part.note}` : '.'}
                  </li>
                ))}
              </ul>
              {backup.after && <p>{backup.after}</p>}
              <div class="actions">
                <button
                  class="btn primary"
                  type="button"
                  data-testid="backup-continue"
                  onClick={() => props.onDone(true)}
                >
                  Continue
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {stored.length > 0 && !saved && !already && (
        <p class="small" data-testid="stored-count">
          {stored.length === 1 ? '1 backup' : `${stored.length} backups`} of this model in this browser.{' '}
          {backup.how === 'read' && radio.method !== 'gd77-hid'
            ? 'The page first checks which radio this is, and does not read one it already has again. '
            : ''}
          <a href="#backups">See {stored.length === 1 ? 'it' : 'them'}</a>
        </p>
      )}

      <details class="more" data-testid="backup-about" open={missing.length > 0}>
        <summary>What is in the backup?</summary>
        <p>
          The page reads {backup.holds} and saves it as one zip file.{' '}
          {backup.restorable
            ? 'That file is the way back to what the radio runs now: the page can flash it back.'
            : 'The page cannot write it back, but it is the record of what your radio held, including what a repair would need.'}{' '}
          Keep it, and keep it private: it is specific to your radio.
        </p>
        {backup.caveat && <p>{backup.caveat}</p>}
        <p>
          The copy kept in this browser is a convenience. It goes when the browser’s site data is cleared and
          does not follow you to another computer: the downloaded file is the backup.
        </p>
        {saved && saved.manifest.notes.length > 0 && (
          <>
            <p>From this read:</p>
            <ul data-testid="backup-notes">
              {saved.manifest.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </>
        )}
      </details>
    </div>
  );
}
