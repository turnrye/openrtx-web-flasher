// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The backup step. The page reads the radio (in flashing mode where the bootloader can
 * be read, otherwise through the original firmware with the radio in normal mode),
 * hands the result to the browser as a download and keeps a second copy in the browser.
 * The step ends with a backup or with the user going on without one.
 *
 * Reading changes nothing on the radio, so no radio is held back here for not being
 * checked on hardware: that question belongs to the flash step.
 */
import { useEffect, useState } from 'preact/hooks';
import { makeBundle, type BundleManifest } from '../backup/bundle.ts';
import type { BackupRecord, BackupStore } from '../backup/store.ts';
import { isAlready } from '../backup/types.ts';
import { siteUrl } from '../base.ts';
import { COVERAGE_DOC_URL, gapLine, gapsFor } from '../coverage.ts';
import { isChooserCancel, type DeviceEnv } from '../devices.ts';
import { saveFile } from '../firmware/builds.ts';
import { backupDevice, type PickedDevice, type Purpose } from '../flash/run.ts';
import type { Progress } from '../flash/types.ts';
import { backupFor, idIsPerUnit, type Radio } from '../radios.ts';
import { runsNow, type Runs } from '../settings.ts';
import { Activity, Console, paintGate } from './Activity.tsx';
import { ChooserHelp, ChooserHint } from './Chooser.tsx';
import { formatDate, formatSize, Notice, Out } from './common.tsx';
import { StillFailing, type ReportDraft } from './Report.tsx';

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
  /**
   * What the radio runs now, for radios that are read through their original firmware:
   * one that already runs OpenRTX cannot be read. Null until the user has said.
   */
  runs: Runs | null;
}

/** Nothing backed up, nothing skipped, nothing said. */
export const NO_BACKUP: BackupState = { saved: null, skipped: false, already: null, runs: null };

/** True when `radio` is read through its original firmware, so the page must ask what it runs. */
export function readThroughOriginal(radio: Radio): boolean {
  const backup = backupFor(radio);
  return backup.how === 'read' && backup.mode === 'normal';
}

/**
 * Where the backup step starts for `radio`. A model the user said runs OpenRTX already
 * has nothing to read, so its step starts finished and an upgrade goes straight on to
 * flashing mode; the folded bar still says why and lets the answer be changed.
 */
export function startBackup(radio: Radio): BackupState {
  if (!readThroughOriginal(radio)) return NO_BACKUP;
  const runs = runsNow.get(radio.id);
  return { ...NO_BACKUP, runs, skipped: runs === 'openrtx' };
}

interface Props {
  radio: Radio;
  env: DeviceEnv;
  store: BackupStore;
  /** Whether this browser can talk to this radio at all. */
  supported: boolean;
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
  /** Shows the list of stored backups. */
  onShowBackups: () => void;
}

/** The last characters of a radio ID, enough to tell two radios apart at a glance. */
export function shortId(id: string | null): string {
  return id ? `…${id.slice(-8)}` : 'no ID';
}

/** The row of buttons and notes under a step's text. */
const ACTIONS = 'flex flex-wrap items-center gap-x-4 gap-y-2';

/** The backup step of the page. */
export function BackupStep(props: Props) {
  const { radio, env, store, supported, getDevice, dropDevice, state, onState, onBusy } = props;
  const backup = backupFor(radio);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress>({ phase: 'connect', done: 0, total: 1 });
  const [error, setError] = useState('');
  /** True after the browser's device list was closed without a pick. */
  const [cancelled, setCancelled] = useState(false);
  /** What the reader logged during the last attempt: shown in the console, and sent with a report. */
  const [log, setLog] = useState<string[]>([]);
  const [startedAt, setStartedAt] = useState(0);

  useEffect(() => {
    setError('');
    setCancelled(false);
  }, [radio.id]);

  /** Goes on without a backup from this page. */
  const skip = () => {
    onState({ ...state, skipped: true });
    props.onDone(false);
  };

  if (backup.how !== 'read') {
    return (
      <div class="flex flex-col gap-4" data-testid="backup-copy">
        <p>{backup.text}</p>
        <div class={ACTIONS}>
          <button class="btn btn-primary" type="button" data-testid="backup-continue" onClick={skip}>
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
  /** The memories this backup does not hold whole, from the coverage record. */
  const gaps = gapsFor(radio);
  /** The site's page on what each backup holds. */
  const coveragePage = siteUrl('flasher/backup-coverage/');
  // A browser that cannot read the radio has nothing to gain from the answer.
  const asks = backup.mode === 'normal' && supported;

  /** Takes the answer to "what does the radio run now?" and remembers it for this model. */
  const answer = (runs: Runs) => {
    runsNow.set(radio.id, runs);
    setError('');
    setCancelled(false);
    onState({ ...state, runs, skipped: false });
  };

  /**
   * Reads the radio, hands the bundle to the browser as a download and keeps a copy. The
   * reader first learns which radio it is; when this browser already holds a complete
   * backup of that one, the read stops there, unless `again` asks for a new one.
   */
  const run = async (again = false) => {
    setError('');
    setCancelled(false);
    let picked: PickedDevice;
    try {
      picked = await getDevice('backup');
    } catch (e) {
      if (isChooserCancel(e)) setCancelled(true);
      else setError(e instanceof Error ? e.message : String(e));
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
        onState({ ...state, saved: null, skipped: false, already: record });
        return;
      }
      const source = backup.mode === 'normal' ? 'original-firmware' : 'flashing-mode';
      const { name, zip, manifest } = await makeBundle(radio, read, source, new Date());
      // Hand the file to the user before anything else can go wrong.
      saveFile(name, zip);
      const kept = await store.save({ name, manifest, restorable: backup.restorable, size: zip.length, zip });
      onState({ ...state, saved: { name, zip, manifest, kept }, skipped: false, already: null });
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
  const fresh = !running && !saved && !already;
  /** The words for the stored backups of this model, with a way to see them. */
  const storedNote = stored.length > 0 && (
    <>
      {stored.length === 1 ? '1 backup' : `${stored.length} backups`} of this model in this browser.{' '}
      <button class="link link-primary" type="button" data-testid="see-backups" onClick={props.onShowBackups}>
        See {stored.length === 1 ? 'it' : 'them'}
      </button>
    </>
  );

  /** The question a radio read through its original firmware is asked first. */
  const question = asks && (
    <fieldset class="fieldset gap-2 p-0" data-testid="runs-now">
      <legend class="fieldset-legend pt-0 text-base font-medium">What does the radio run now?</legend>
      <div class="join max-sm:join-vertical">
        <button
          class={`btn join-item ${state.runs === 'original' ? 'btn-active border-secondary' : ''}`}
          type="button"
          aria-pressed={state.runs === 'original'}
          disabled={running}
          data-testid="runs-original"
          onClick={() => answer('original')}
        >
          The original firmware
        </button>
        <button
          class={`btn join-item ${state.runs === 'openrtx' ? 'btn-active border-secondary' : ''}`}
          type="button"
          aria-pressed={state.runs === 'openrtx'}
          disabled={running}
          data-testid="runs-openrtx"
          onClick={() => answer('openrtx')}
        >
          OpenRTX already
        </button>
      </div>
      <p class="label text-sm text-wrap">
        The page reads this radio through the firmware its maker put on it. It remembers your answer for the{' '}
        {radio.name}.
      </p>
    </fieldset>
  );

  if (asks && state.runs !== 'original') {
    return (
      <div class="flex flex-col gap-4" data-testid="backup-read">
        {question}
        {state.runs === 'openrtx' && (
          <div class="flex flex-col gap-4" data-testid="backup-runs-openrtx">
            <p>
              Nothing can be read through OpenRTX: the page reads the {radio.name} through its original
              firmware only. There is no backup to take now.
            </p>
            {storedNote ? (
              <p data-testid="stored-count">{storedNote}</p>
            ) : (
              <p class="text-sm text-muted">This browser holds no backup of this model from before.</p>
            )}
            <div class={ACTIONS}>
              <button class="btn btn-primary" type="button" data-testid="backup-continue" onClick={skip}>
                Continue without a backup
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div class="flex flex-col gap-4" data-testid="backup-read">
      {question}
      <p>
        Save what the radio holds before you flash it.
        {backup.mode === 'normal' &&
          ' Put the radio in normal mode: switch it on without holding any keys, and connect the programming cable.'}
      </p>
      {backup.notIncluded && (
        <p data-testid="backup-not-included">
          {backup.notIncluded.text}{' '}
          <Out href={backup.notIncluded.url === COVERAGE_DOC_URL ? coveragePage : backup.notIncluded.url}>
            {backup.notIncluded.label}
          </Out>
          .
        </p>
      )}
      {gaps.length > 0 && (
        // Said before the read, not after: what this backup will not hold of this radio.
        <Notice tone="warning" testid="backup-gaps">
          <p class="font-medium">
            This backup will not hold everything in the {radio.name}. Not saved, or saved only in part:
          </p>
          <ul class="mt-1 flex list-disc flex-col gap-1 ps-5 text-sm">
            {gaps.map((gap) => (
              <li key={gap.name}>{gapLine(gap)}</li>
            ))}
          </ul>
          <p class="mt-2 text-sm">
            <Out href={coveragePage} testid="backup-gaps-more">
              What would be lost, and how each gap can be closed
            </Out>
          </p>
        </Notice>
      )}

      {!supported ? (
        <div class="flex flex-col gap-3" data-testid="backup-needs-browser">
          <p>This browser cannot read this radio.</p>
          {backup.command ? (
            <>
              <p>With the usual tool:</p>
              <pre
                class="overflow-x-auto rounded-box bg-base-200 p-3 font-mono text-sm"
                data-testid="command"
              >
                {backup.command}
              </pre>
            </>
          ) : (
            <p>Your programming software can save the channels and settings.</p>
          )}
          <div class={ACTIONS}>
            <button class="btn btn-primary" type="button" data-testid="backup-skip" onClick={skip}>
              Continue
            </button>
          </div>
        </div>
      ) : (
        <>
          {already && !saved && !running && (
            <Notice tone="success" role="status" testid="backup-already">
              <div class="flex flex-col gap-3">
                <p>
                  This radio ({shortId(already.manifest.radioId)}) was already backed up in this browser on{' '}
                  {formatDate(already.manifest.taken)}, so the page did not read it again.{' '}
                  <button
                    class="link link-primary"
                    type="button"
                    data-testid="backup-save-stored"
                    onClick={() => void saveStored(already.name)}
                  >
                    Save a copy of that backup
                  </button>
                </p>
                <div>
                  <button
                    class="btn btn-primary"
                    type="button"
                    data-testid="backup-continue"
                    onClick={() => props.onDone(true)}
                  >
                    Continue
                  </button>
                </div>
              </div>
            </Notice>
          )}
          {saved && !running && (
            <Notice tone="success" role="status" testid="backup-done">
              <div class="flex flex-col gap-3">
                <p>
                  Saved <span class="break-all">{saved.name}</span> ({formatSize(saved.zip.length)}) to your
                  downloads
                  {saved.kept ? ', and kept a copy in this browser' : ''}.{' '}
                  <button
                    class="link link-primary"
                    type="button"
                    data-testid="backup-save-again"
                    onClick={() => saveFile(saved.name, saved.zip)}
                  >
                    Save it again
                  </button>
                </p>
                <ul class="flex list-disc flex-col gap-1 ps-5 text-sm">
                  <li class="break-all">
                    Radio ID: {saved.manifest.radioId ?? 'this radio does not report one'}
                  </li>
                  {saved.manifest.firmware && <li>Firmware on the radio: {saved.manifest.firmware}</li>}
                  {missing.map((part) => (
                    <li key={part.file} class="text-warning">
                      {part.file} is incomplete{part.note ? `: ${part.note}` : '.'}
                    </li>
                  ))}
                </ul>
                {backup.after && <p>{backup.after}</p>}
                <div>
                  <button
                    class="btn btn-primary"
                    type="button"
                    data-testid="backup-continue"
                    onClick={() => props.onDone(true)}
                  >
                    Continue
                  </button>
                </div>
              </div>
            </Notice>
          )}
          {error && (
            <Notice tone="error" role="alert" testid="backup-error">
              <p>{error}</p>
              {/* Some readers say it themselves, in their own words. */}
              {!/nothing was sent/i.test(error) && (
                <p class="mt-1 text-sm" data-testid="backup-untouched">
                  Reading changes nothing on the radio.
                </p>
              )}
            </Notice>
          )}
          {!running && <ChooserHint radio={radio} />}
          <div class={ACTIONS}>
            <button
              class={`btn ${saved || already ? '' : 'btn-primary'}`}
              type="button"
              disabled={running}
              data-testid="backup"
              onClick={() => void run(!!already || !!saved)}
            >
              {running && <span class="loading loading-spinner loading-sm" data-testid="spinner" />}
              {running
                ? 'Reading the radio…'
                : saved
                  ? 'Back up again'
                  : already
                    ? 'Back up again anyway'
                    : error
                      ? 'Try again'
                      : 'Back up now'}
            </button>
            {fresh && <span class="text-sm text-muted">Takes {backup.time}.</span>}
            {!running && already && backup.endsFlashingMode && (
              <span class="text-sm text-muted">Put the radio in flashing mode again first.</span>
            )}
            {fresh && backup.unchecked && (
              <span class="badge badge-outline badge-warning" data-testid="backup-unchecked">
                Unchecked on this model
              </span>
            )}
            {running && <span class="text-sm">Do not unplug or switch off the radio.</span>}
            {fresh && (
              <button class="btn btn-ghost" type="button" data-testid="backup-skip" onClick={skip}>
                Skip the backup
              </button>
            )}
          </div>
          {cancelled && <ChooserHelp radio={radio} purpose="backup" />}
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
          {error && <StillFailing radio={radio} purpose="backup" report={failure} />}
        </>
      )}

      {storedNote && !saved && !already && (
        <p class="text-sm" data-testid="stored-count">
          {storedNote}
          {/* Only where the radio gives an ID that is surely its own, and gives it before the read. */}
          {idIsPerUnit(radio) &&
            ' The page first checks which radio this is, and does not read one it already has again.'}
        </p>
      )}

      <details
        class="collapse-arrow collapse border border-separator"
        data-testid="backup-about"
        open={missing.length > 0}
      >
        <summary class="collapse-title min-h-0 py-2 text-sm">What is in the backup?</summary>
        <div class="collapse-content flex flex-col gap-2 text-sm">
          <p>
            The page reads {backup.holds} and saves it as one zip file.{' '}
            {backup.restorable
              ? 'That file is the way back to what the radio runs now: the page can flash it back.'
              : 'The page cannot write it back. It is a record of what the page could read from your radio, not of everything in it.'}{' '}
            Keep it, and keep it private: it is specific to your radio.
          </p>
          {backup.caveat && <p>{backup.caveat}</p>}
          <p>
            The copy kept in this browser is a convenience. It goes when the browser’s site data is cleared
            and does not follow you to another computer: the downloaded file is the backup.
          </p>
          {saved && saved.manifest.notes.length > 0 && (
            <>
              <p>From this read:</p>
              <ul class="flex list-disc flex-col gap-1 ps-5" data-testid="backup-notes">
                {saved.manifest.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      </details>
    </div>
  );
}
