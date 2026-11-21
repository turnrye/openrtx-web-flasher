// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The page: pick a radio, pick a firmware build, back the radio up, put it in flashing
 * mode, flash it. One step is open at a time; a finished step folds to its bar.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { backupStore, type BackupRecord } from './backup/store.ts';
import { browserEnv, type DeviceEnv, type WebApi } from './devices.ts';
import {
  buildFromBundle,
  buildFromLocalFile,
  fileForRadio,
  loadManifest,
  type Build,
  type Manifest,
} from './firmware/builds.ts';
import { pickDevice, type PickedDevice, type Purpose } from './flash/run.ts';
import { apiFor, backupFor, radioById, radioForFile, RADIOS, type Radio } from './radios.ts';
import { experimental } from './settings.ts';
import { BackupsSection } from './ui/BackupsSection.tsx';
import { BackupStep, NO_BACKUP, shortId, type BackupState } from './ui/BackupStep.tsx';
import { Step, type StepMode } from './ui/common.tsx';
import { EnterStep } from './ui/EnterStep.tsx';
import { FirmwareStep } from './ui/FirmwareStep.tsx';
import { FlashStep } from './ui/FlashStep.tsx';
import { RadioArt } from './ui/RadioArt.tsx';
import { ReportLink } from './ui/Report.tsx';

const APIS: WebApi[] = ['usb', 'serial', 'hid'];

/** `?sim=…` in the address switches the page to simulated radios. */
const SIM = new URLSearchParams(location.search).get('sim');

/** The steps of the page. */
type StepId = 'radio' | 'firmware' | 'backup' | 'enter' | 'flash';

/** Which steps are done; the flash step never is. */
type Done = Record<Exclude<StepId, 'flash'>, boolean>;

/**
 * True when the backup step comes before flashing mode: the radio is read in normal
 * mode, or the page cannot read it and the step says what to keep instead.
 */
function backupFirst(radio: Radio | null): boolean {
  if (!radio) return true;
  const backup = backupFor(radio);
  return backup.how === 'none' || (backup.how === 'read' && backup.mode === 'normal');
}

/** The steps in the order they happen for `radio`. */
function stepsFor(radio: Radio | null): StepId[] {
  return [
    'radio',
    'firmware',
    ...(backupFirst(radio) ? (['backup', 'enter'] as const) : (['enter', 'backup'] as const)),
    'flash',
  ];
}

/** The first step of `order` that is not done. */
function firstUndone(order: StepId[], done: Done): StepId {
  return order.find((step) => step === 'flash' || !done[step]) ?? 'flash';
}

/** The whole page. */
export function App() {
  const [env, setEnv] = useState<DeviceEnv | null>(SIM ? null : browserEnv());
  const [radio, setRadio] = useState<Radio | null>(() => radioById(location.hash.slice(1)) ?? null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [build, setBuild] = useState<Build | null>(null);
  const [exp, setExp] = useState(experimental.get());
  const [backup, setBackup] = useState<BackupState>(NO_BACKUP);
  const [entered, setEntered] = useState(false);
  const [open, setOpen] = useState<StepId>(radio ? 'firmware' : 'radio');
  const [busy, setBusy] = useState(false);
  const [dropError, setDropError] = useState('');
  const [records, setRecords] = useState<BackupRecord[]>([]);
  const [unreleasedOpen, setUnreleasedOpen] = useState(false);
  // The device stays picked for as long as the radio stays chosen and in the same mode,
  // so backing up in flashing mode and then flashing asks for it only once.
  const device = useRef<PickedDevice | null>(null);
  // Simulated radios get a store of their own, so trying the page out leaves no
  // pretend backups next to real ones.
  const store = useMemo(() => backupStore(Boolean(SIM)), []);
  const refreshRecords = useCallback(() => void store.list().then(setRecords), [store]);

  const file = radio ? fileForRadio(radio, build) : undefined;
  // Radios in the current OpenRTX release are listed first; the rest fold away under
  // "No release yet". With no release to go by, every radio is in the one list.
  const release = manifest?.builds.find((b) => b.kind === 'release');
  const released = release ? RADIOS.filter((r) => fileForRadio(r, release)) : RADIOS;
  const unreleased = RADIOS.filter((r) => !released.includes(r));
  const order = stepsFor(radio);
  const done: Done = {
    radio: !!radio,
    firmware: !!file,
    backup: backup.saved !== null || backup.skipped || backup.already !== null,
    enter: entered,
  };

  useEffect(() => {
    void loadManifest().then((m) => setManifest(m ?? { generated: '', source: '', builds: [] }));
    // The simulators are a separate chunk: real users never download them.
    if (SIM) void import('./sim/env.ts').then((m) => setEnv(m.simulatedEnv(SIM)));
    refreshRecords();
  }, [refreshRecords]);

  // The handlers below are called from listeners set up once; they read the latest state here.
  const latest = useRef({ radio, build, done, busy });
  latest.current = { radio, build, done, busy };

  /** Chooses a radio and remembers it in the address, so the page can be linked. */
  function selectRadio(next: Radio, withBuild: Build | null = latest.current.build) {
    const same = next.id === latest.current.radio?.id;
    if (!same) {
      device.current = null;
      setBackup(NO_BACKUP);
      setEntered(false);
    }
    setRadio(next);
    history.replaceState(null, '', `#${next.id}`);
    const now = latest.current.done;
    setOpen(
      firstUndone(stepsFor(next), {
        radio: true,
        firmware: !!fileForRadio(next, withBuild),
        backup: same && now.backup,
        enter: same && now.enter,
      }),
    );
  }

  /** Takes a build; when it has a file for the radio, the firmware step is done. */
  function chooseBuild(next: Build | null) {
    setDropError('');
    setBuild(next);
    const current = latest.current.radio;
    if (current && fileForRadio(current, next)) {
      setOpen(firstUndone(stepsFor(current), { ...latest.current.done, firmware: true }));
    }
  }

  /** Takes a file dropped anywhere on the page, or a backup chosen to restore. */
  function takeLocal(local: Build) {
    // A backup names its radio model; a build is recognised by its file names.
    const owners = new Set(
      local.backup ? [local.backup.radio] : local.files.map((f) => radioForFile(f.name)?.id).filter(Boolean),
    );
    const owner = owners.size === 1 ? radioById([...owners][0]!) : undefined;
    setDropError('');
    setBuild(local);
    const current = latest.current.radio;
    if (owner && (!current || local.backup)) {
      selectRadio(owner, local);
    } else if (current) {
      setOpen(
        fileForRadio(current, local)
          ? firstUndone(stepsFor(current), { ...latest.current.done, firmware: true })
          : 'firmware',
      );
    }
  }

  // A file dropped anywhere on the page becomes the firmware, and picks the radio when
  // its name says which one it is for.
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      const dropped = e.dataTransfer?.files[0];
      if (!dropped) return;
      e.preventDefault();
      // Not while the radio is being read or written: the file in hand stays the file.
      if (latest.current.busy) return;
      buildFromLocalFile(dropped).then(takeLocal, (err: unknown) =>
        setDropError(err instanceof Error ? err.message : 'Could not read that file.'),
      );
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);

  /** Makes a backup kept in this browser the firmware to flash onto the radio it came from. */
  async function restore(name: string) {
    if (latest.current.busy) return;
    const stored = await store.get(name);
    if (!stored) return;
    try {
      takeLocal(await buildFromBundle(stored.name, stored.zip));
      document.getElementById('step-radio')?.scrollIntoView({ block: 'start' });
    } catch (e) {
      setDropError(e instanceof Error ? e.message : 'Could not read that backup.');
    }
  }

  /** Turns experimental flashing on or off, for every radio. */
  const setExperimental = (on: boolean) => {
    experimental.set(on);
    setExp(on);
  };

  /** Finishes the backup step. A read that ended flashing mode sends the user back to enter it again. */
  const backupDone = (read: boolean) => {
    const info = radio ? backupFor(radio) : null;
    const reenter = read && info?.how === 'read' && !!info.endsFlashingMode;
    if (reenter) setEntered(false);
    setOpen(firstUndone(order, { ...done, backup: true, enter: reenter ? false : done.enter }));
  };

  const dropDevice = useCallback(() => {
    device.current = null;
  }, []);
  // A radio read through its original firmware is another device than the same radio
  // in flashing mode, so that one is asked for each time and not kept.
  const getDevice = useCallback(
    async (purpose: Purpose) => {
      if (!radio || !env) throw new Error('No radio chosen.');
      return purpose === 'backup' && backupFirst(radio)
        ? pickDevice(radio, env, 'backup')
        : (device.current ??= await pickDevice(radio, env, 'flash'));
    },
    [radio, env],
  );

  const api = radio ? apiFor(radio.method) : null;
  const supported = !!env && api !== null && env.supports(api);
  const allowed = !!radio && (radio.verified !== null || exp);
  const anyApi = env ? APIS.some((a) => env.supports(a)) : true;
  const how = radio ? backupFor(radio) : null;
  /** True when the user is back at the flashing-mode step because a backup ended it. */
  const enterAgain =
    how?.how === 'read' &&
    !!how.endsFlashingMode &&
    (backup.saved !== null || backup.already !== null) &&
    !entered;

  /** How a step shows: open, folded (it can be opened), or waiting for the steps before it. */
  const mode = (step: StepId): StepMode => {
    const before = order.slice(0, order.indexOf(step)) as Exclude<StepId, 'flash'>[];
    const reachable = before.every((s) => done[s]) && (step === 'radio' || step === 'firmware' || !!env);
    if (!reachable) return 'waiting';
    return open === step ? 'open' : 'folded';
  };
  /** Opens a step, unless the radio is being read or written. */
  const opener = (step: StepId) => (busy ? undefined : () => setOpen(step));
  const number = (step: StepId) => order.indexOf(step) + 1;
  /** How the backup step ended, for a report. Says nothing about what the backup holds. */
  const backupSummary = backup.saved
    ? backup.saved.manifest.parts.every((part) => part.complete)
      ? 'saved, complete'
      : 'saved, some parts incomplete'
    : backup.already
      ? 'taken earlier'
      : backup.skipped
        ? how?.how === 'copy'
          ? 'copied by hand'
          : 'skipped'
        : undefined;

  const backupStep = (
    <Step
      key="backup"
      num={number('backup')}
      title="Back up"
      id="step-backup"
      mode={mode('backup')}
      onOpen={opener('backup')}
      state={
        backup.saved
          ? `saved · radio ${shortId(backup.saved.manifest.radioId)}`
          : backup.already
            ? `already backed up · radio ${shortId(backup.already.manifest.radioId)}`
            : backup.skipped
              ? how?.how === 'copy'
                ? 'done'
                : 'skipped'
              : undefined
      }
    >
      {radio && env && (
        <BackupStep
          radio={radio}
          env={env}
          store={store}
          supported={supported}
          allowed={allowed}
          onExperimental={() => setExperimental(true)}
          getDevice={getDevice}
          dropDevice={dropDevice}
          state={backup}
          onState={setBackup}
          onBusy={setBusy}
          onStored={refreshRecords}
          onDone={backupDone}
          records={records}
        />
      )}
    </Step>
  );
  const enterStep = (
    <Step
      key="enter"
      num={number('enter')}
      title="Flashing mode"
      id="step-enter"
      mode={mode('enter')}
      onOpen={opener('enter')}
      state={entered ? 'done' : undefined}
    >
      {radio && (
        <EnterStep
          radio={radio}
          again={enterAgain}
          onDone={() => {
            setEntered(true);
            setOpen(firstUndone(order, { ...done, enter: true }));
          }}
        />
      )}
    </Step>
  );

  /** One radio in the picker. */
  const card = (r: Radio) => (
    <button
      key={r.id}
      type="button"
      class="radio-card"
      aria-pressed={radio?.id === r.id}
      data-testid={`radio-${r.id}`}
      onClick={() => selectRadio(r)}
    >
      <RadioArt id={r.id} />
      <span class="name">{r.name}</span>
      {r.aka && <span class="aka">{r.aka}</span>}
    </button>
  );

  return (
    <div class="page">
      <header class="topbar">
        <img src="openrtx_logo.svg" alt="" />
        <h1>OpenRTX Flasher</h1>
        <span class="tag" title="Community prototype, not an official OpenRTX release">
          prototype
        </span>
      </header>

      <p class="intro">
        Put <a href="https://openrtx.org">OpenRTX</a>, the free firmware for digital ham radios, on your
        radio. Pick the radio, pick a version, and follow the steps.
      </p>

      {env?.simulated && (
        <p class="banner sim" data-testid="sim-banner">
          Simulator: flashing goes to a simulated radio. Nothing is sent to real hardware.
        </p>
      )}
      {!anyApi && (
        <p class="banner" data-testid="no-apis">
          This browser cannot talk to radios. Downloads and instructions work everywhere; to flash from the
          page, use Chrome or Edge on a computer.
        </p>
      )}

      <Step
        num={1}
        title="Radio"
        id="step-radio"
        mode={mode('radio')}
        onOpen={opener('radio')}
        state={radio?.name}
        hint="change"
      >
        {/* Drawn once the builds are known, so no radio moves between the lists. */}
        {manifest && (
          <>
            <div class="radios">{released.map(card)}</div>
            {unreleased.length > 0 && (
              <details
                class="more unreleased"
                data-testid="no-release"
                open={unreleasedOpen || (radio !== null && unreleased.includes(radio))}
                onToggle={(e) => setUnreleasedOpen(e.currentTarget.open)}
              >
                <summary>No release yet ({unreleased.length})</summary>
                <p class="muted">
                  OpenRTX has not released firmware for these radios yet. They take a development build, or a
                  file you bring.
                </p>
                <div class="radios">{unreleased.map(card)}</div>
              </details>
            )}
          </>
        )}
      </Step>

      <Step
        num={2}
        title="Firmware"
        id="step-firmware"
        mode={mode('firmware')}
        onOpen={opener('firmware')}
        state={file ? build?.label : undefined}
        hint="change"
      >
        {radio && <FirmwareStep radio={radio} manifest={manifest} build={build} onBuild={chooseBuild} />}
        {dropError && (
          <p class="panel error" role="alert" data-testid="drop-error">
            {dropError}
          </p>
        )}
      </Step>

      {backupFirst(radio) ? [backupStep, enterStep] : [enterStep, backupStep]}

      <Step num={5} title="Flash" id="step-flash" mode={mode('flash')} onOpen={opener('flash')}>
        {radio && build && file && env && (
          <FlashStep
            radio={radio}
            build={build}
            file={file}
            env={env}
            supported={supported}
            allowed={allowed}
            onExperimental={setExperimental}
            getDevice={getDevice}
            dropDevice={dropDevice}
            onBusy={setBusy}
            backupSummary={backupSummary}
          />
        )}
      </Step>

      {records.length > 0 && (
        <Step title="Backups" id="backups" mode="open">
          <BackupsSection
            store={store}
            records={records}
            onChanged={refreshRecords}
            onRestore={(name) => void restore(name)}
            busy={busy}
          />
        </Step>
      )}

      <footer>
        <p>
          Community prototype for the <a href="https://openrtx.org">OpenRTX</a> project. Free software under
          the GNU GPL v3 or later; <a href="https://github.com/turnrye/openrtx-web-flasher">source</a>,{' '}
          <a href="licences.html" data-testid="licences">
            licences and credits
          </a>
          . Flashing firmware is at your own risk.{' '}
          <ReportLink report={{ outcome: 'suggestion' }} label="Feedback" testid="feedback" plain />.
        </p>
        {manifest?.generated && (
          <p>
            Firmware copied from {manifest.source} on {new Date(manifest.generated).toLocaleString()}.
          </p>
        )}
        <p data-testid="site-build">Build {__BUILD_ID__}.</p>
      </footer>
    </div>
  );
}
