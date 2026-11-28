// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The flasher: pick a radio, pick a firmware build, back the radio up, put it in
 * flashing mode, flash it. One step is open at a time; a finished step folds to its bar.
 * It is one page of the site (site/components/FlasherIsland.astro mounts it), so the
 * site's header and the page's title are not its business.
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
import {
  BackupStep,
  NO_BACKUP,
  readThroughOriginal,
  shortId,
  startBackup,
  type BackupState,
} from './ui/BackupStep.tsx';
import { BeforeYouStart } from './ui/BeforeYouStart.tsx';
import { BuildFacts } from './ui/BuildFacts.tsx';
import { formatDateTime, Notice, Step, type StepMode } from './ui/common.tsx';
import { EnterStep } from './ui/EnterStep.tsx';
import { FirmwareStep } from './ui/FirmwareStep.tsx';
import { FlashStep } from './ui/FlashStep.tsx';
import { ProgressRail, type RailStep } from './ui/ProgressRail.tsx';
import { RadioPicker } from './ui/RadioPicker.tsx';
import { ReportLink } from './ui/Report.tsx';

const APIS: WebApi[] = ['usb', 'serial', 'hid'];

/** `?sim=…` in the address switches the page to simulated radios. */
const SIM = new URLSearchParams(location.search).get('sim');

/** The steps of the page. */
type StepId = 'radio' | 'firmware' | 'backup' | 'enter' | 'flash';

/** Which steps are done; the flash step never is. */
type Done = Record<Exclude<StepId, 'flash'>, boolean>;

/** The radio the address names (`#md3x0`), if it names one. */
function radioInAddress(): Radio | undefined {
  return radioById(location.hash.slice(1));
}

/** True when `radio` is backed up in normal mode, before it is put in flashing mode. */
function backupFirst(radio: Radio | null): boolean {
  return !radio || readThroughOriginal(radio);
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

/** Each step's name as the page shows it. */
const TITLES: Record<StepId, string> = {
  radio: 'Radio',
  firmware: 'Firmware',
  backup: 'Back up',
  enter: 'Flashing mode',
  flash: 'Flash',
};

/** The first step of `order` that is not done. */
function firstUndone(order: StepId[], done: Done): StepId {
  return order.find((step) => step === 'flash' || !done[step]) ?? 'flash';
}

/** True when the backup step of `state` needs nothing more from the user. */
function backedUp(state: BackupState): boolean {
  return state.saved !== null || state.skipped || state.already !== null;
}

/** The flasher. */
export function App() {
  const [env, setEnv] = useState<DeviceEnv | null>(SIM ? null : browserEnv());
  const [radio, setRadio] = useState<Radio | null>(() => radioInAddress() ?? null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [build, setBuild] = useState<Build | null>(null);
  const [exp, setExp] = useState(experimental.get());
  const [backup, setBackup] = useState<BackupState>(() => (radio ? startBackup(radio) : NO_BACKUP));
  const [entered, setEntered] = useState(false);
  const [open, setOpen] = useState<StepId>(radio ? 'firmware' : 'radio');
  const [busy, setBusy] = useState(false);
  const [dropError, setDropError] = useState('');
  const [records, setRecords] = useState<BackupRecord[]>([]);
  /** Counts the radios flashed in a row; a new count starts the flash step afresh. */
  const [round, setRound] = useState(0);
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
    backup: backedUp(backup),
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
    const fresh = startBackup(next);
    if (!same) {
      device.current = null;
      setBackup(fresh);
      setEntered(false);
    }
    setRadio(next);
    if (location.hash !== `#${next.id}`) history.replaceState(null, '', `#${next.id}`);
    const now = latest.current.done;
    setOpen(
      firstUndone(stepsFor(next), {
        radio: true,
        firmware: !!fileForRadio(next, withBuild),
        backup: same ? now.backup : backedUp(fresh),
        enter: same && now.enter,
      }),
    );
  }

  // The address carries the radio: a link, the back button or an edited address chooses it.
  useEffect(() => {
    const changed = () => {
      const named = radioInAddress();
      // Not while a radio is being read or written: that radio stays the radio.
      if (named && named.id !== latest.current.radio?.id && !latest.current.busy) selectRadio(named);
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);

  // Leaving the page in the middle of a read or a write asks first: a flash that is cut
  // off can leave the radio without working firmware.
  useEffect(() => {
    if (!busy) return;
    const ask = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Chrome asks only when this is set as well.
      e.returnValue = true;
    };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [busy]);

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

  /**
   * Starts over for a second radio of the same model: it is a new radio, so its backup,
   * its flashing mode and the device the browser was given are all asked for again. The
   * radio model and the firmware stay.
   */
  const flashAnother = () => {
    device.current = null;
    setBackup(NO_BACKUP);
    setEntered(false);
    setRound((n) => n + 1);
    setOpen(firstUndone(order, { ...done, backup: false, enter: false }));
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
  /** The steps as the progress rail shows them: the open one, those done, those to come. */
  const rail: RailStep[] = order.map((step) => ({
    id: step,
    title: TITLES[step],
    status:
      step === open
        ? 'current'
        : step !== 'flash' && done[step] && mode(step) !== 'waiting'
          ? 'done'
          : 'upcoming',
    onOpen: opener(step),
  }));
  /** True when there is nothing to back up because the radio already runs OpenRTX. */
  const runsOpenrtx = backup.skipped && backup.runs === 'openrtx';
  /** How the backup step ended, for a report. Says nothing about what the backup holds. */
  const backupSummary = backup.saved
    ? backup.saved.manifest.parts.every((part) => part.complete)
      ? 'saved, complete'
      : 'saved, some parts incomplete'
    : backup.already
      ? 'taken earlier'
      : runsOpenrtx
        ? 'none: the radio already ran OpenRTX'
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
      hint={runsOpenrtx ? 'change' : undefined}
      state={
        backup.saved
          ? `saved · radio ${shortId(backup.saved.manifest.radioId)}`
          : backup.already
            ? `already backed up · radio ${shortId(backup.already.manifest.radioId)}`
            : runsOpenrtx
              ? 'not needed: runs OpenRTX'
              : backup.skipped
                ? how?.how === 'copy'
                  ? 'done'
                  : 'skipped'
                : undefined
      }
    >
      {radio && env && (
        <BackupStep
          key={round}
          radio={radio}
          env={env}
          store={store}
          supported={supported}
          getDevice={getDevice}
          dropDevice={dropDevice}
          state={backup}
          onState={setBackup}
          onBusy={setBusy}
          onStored={refreshRecords}
          onDone={backupDone}
          records={records}
          onShowBackups={() => document.getElementById('backups')?.scrollIntoView({ block: 'start' })}
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

  return (
    <div class="flex flex-col gap-4 text-base leading-normal" data-testid="flasher">
      <p class="max-w-[70ch] text-lg text-base-content/80">
        Pick the radio, pick a version, and follow the steps: a backup first, then flashing mode, then the
        flash. <span class="badge badge-outline badge-primary badge-sm align-middle">Prototype</span>{' '}
        <span class="text-sm">A community project, not an official OpenRTX release.</span>
      </p>

      {env?.simulated && (
        <Notice tone="info" testid="sim-banner">
          Simulator: flashing goes to a simulated radio. Nothing is sent to real hardware.
        </Notice>
      )}
      {!anyApi && (
        <Notice tone="warning" testid="no-apis">
          This browser cannot talk to radios. Downloads and instructions work everywhere; to flash from the
          page, use Chrome or Edge on a computer.
        </Notice>
      )}

      <BeforeYouStart />

      <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:gap-8">
        <ProgressRail steps={rail} />
        <div class="flex min-w-0 flex-1 flex-col gap-3">
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
              <RadioPicker
                released={released}
                unreleased={unreleased}
                chosen={radio}
                onChoose={selectRadio}
              />
            )}
          </Step>

          <Step
            num={2}
            title="Firmware"
            id="step-firmware"
            mode={mode('firmware')}
            onOpen={opener('firmware')}
            state={file ? build?.label : undefined}
            detail={file && build ? <BuildFacts build={build} testid="chosen-build" /> : undefined}
            hint="change"
          >
            {radio && <FirmwareStep radio={radio} manifest={manifest} build={build} onBuild={chooseBuild} />}
            {dropError && (
              <Notice tone="warning" role="alert" testid="drop-error">
                {dropError}
              </Notice>
            )}
          </Step>

          {backupFirst(radio) ? [backupStep, enterStep] : [enterStep, backupStep]}

          <Step num={5} title="Flash" id="step-flash" mode={mode('flash')} onOpen={opener('flash')}>
            {radio && build && file && env && (
              <FlashStep
                key={round}
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
                radioId={backup.saved?.manifest.radioId ?? backup.already?.manifest.radioId}
                onAnother={flashAnother}
              />
            )}
          </Step>
        </div>
      </div>

      {records.length > 0 && (
        <BackupsSection
          store={store}
          records={records}
          onChanged={refreshRecords}
          onRestore={(name) => void restore(name)}
          busy={busy}
        />
      )}

      {/* The site's footer has the licences and credits; this keeps what is the flasher's own. */}
      <footer class="pt-2 text-sm text-muted">
        <p>
          {manifest?.generated && (
            <>
              Firmware copied from {manifest.source} on {formatDateTime(manifest.generated)}.{' '}
            </>
          )}
          <ReportLink
            report={{ outcome: 'suggestion' }}
            label="Feedback on the flasher"
            testid="feedback"
            plain
          />
        </p>
      </footer>
    </div>
  );
}
