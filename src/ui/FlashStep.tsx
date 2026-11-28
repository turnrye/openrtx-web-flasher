// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The last step: write the firmware from the browser, or hand over the file and the
 * command for the usual tool.
 */
import { useEffect, useState } from 'preact/hooks';
import { siteUrl } from '../base.ts';
import { isChooserCancel, type DeviceEnv } from '../devices.ts';
import { asksForSuccess } from '../feedback.ts';
import {
  companionsFor,
  fileBytes,
  saveFile,
  sha256Hex,
  type Build,
  type BuildFile,
} from '../firmware/builds.ts';
import { flashDevice, type PickedDevice, type Purpose } from '../flash/run.ts';
import { WrongRadioError, type Progress, type Segment } from '../flash/types.ts';
import { apiFor, backupFor, filesFor, type Radio } from '../radios.ts';
import { lastFlashed, type Flashed } from '../settings.ts';
import { Activity, paintGate } from './Activity.tsx';
import { BuildFacts, describeBuild } from './BuildFacts.tsx';
import { ChooserHelp, ChooserHint } from './Chooser.tsx';
import { formatDate, formatSize, Notice, Out } from './common.tsx';
import { ExperimentalGate } from './Experimental.tsx';
import { RadioArt } from './RadioArt.tsx';
import { CopyReport, ReportLink, ReportNote, StillFailing, type ReportDraft } from './Report.tsx';
import { OtherTools } from './UseInstead.tsx';

/** Where a flash attempt stands. */
type Status = 'idle' | 'running' | 'done' | 'error';

interface Props {
  radio: Radio;
  build: Build;
  /** The file of `build` that goes onto `radio`. */
  file: BuildFile;
  env: DeviceEnv;
  /** Whether this browser can talk to this radio at all. */
  supported: boolean;
  /** Whether writing to this radio is allowed: it was checked on hardware, or experimental flashing is on. */
  allowed: boolean;
  /** Turns experimental flashing on or off. */
  onExperimental: (on: boolean) => void;
  /** Returns the device for a purpose, opening the browser's chooser when needed. */
  getDevice: (purpose: Purpose) => Promise<PickedDevice>;
  /** Forgets the device, after an error that may mean it went away. */
  dropDevice: () => void;
  /** Tells the page the radio is being written, so nothing else starts. */
  onBusy: (busy: boolean) => void;
  /** How the backup step ended, for a report: "saved, complete", "skipped". */
  backupSummary?: string;
  /** The ID of the radio, when the backup step read it. */
  radioId?: string | null;
  /** Starts over for a second radio of the same model. */
  onAnother: () => void;
}

const API_NAME = { usb: 'WebUSB', serial: 'Web Serial', hid: 'WebHID' } as const;

/** The row of buttons and notes under a step's text. */
const ACTIONS = 'flex flex-wrap items-center gap-x-4 gap-y-2';

/** A download link for a mirrored file, or a button for one that only exists in memory. */
function Download({ file, primary }: { file: BuildFile; primary?: boolean }) {
  const cls = `btn h-auto min-h-(--size) py-1 break-all ${primary ? 'btn-primary' : ''}`;
  const text = `Download ${file.name}`;
  if (file.path) {
    return (
      <a class={cls} href={siteUrl(file.path)} download={file.name} data-testid="download">
        {text}
      </a>
    );
  }
  return (
    <button class={cls} type="button" data-testid="download" onClick={() => saveFile(file.name, file.data!)}>
      {text}
    </button>
  );
}

/**
 * Whether a flash that failed had begun to change the radio. Flashers report an erase or
 * write phase before they send the first such command; cskburn, whose progress is read
 * from what it prints, names the partition it is about to burn before any amount.
 */
export function beganWriting(phases: ReadonlySet<Progress['phase']>, log: readonly string[]): boolean {
  return (
    phases.has('erase') ||
    phases.has('write') ||
    phases.has('verify') ||
    log.some((line) => line.startsWith('Burning partition'))
  );
}

/** True when `build` is what `flashed` records. */
function sameBuild(flashed: Flashed | null, build: Build): flashed is Flashed {
  return !!flashed && flashed.label === build.label && flashed.sha === build.sha;
}

/** The flash step of the page. */
export function FlashStep(props: Props) {
  const { radio, build, file, env, supported, allowed, getDevice, dropDevice, onBusy } = props;
  const [data, setData] = useState<Uint8Array | null>(null);
  /** The other images this radio needs from the build, loaded and ready to write. */
  const [also, setAlso] = useState<Segment[] | null>(null);
  const [hash, setHash] = useState('');
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [progress, setProgress] = useState<Progress>({ phase: 'connect', done: 0, total: 1 });
  const [message, setMessage] = useState('');
  /** Whether the attempt that failed had begun to erase or write. */
  const [wrote, setWrote] = useState(false);
  /** True when the flash was refused because the backup is another radio's: nothing to report. */
  const [refused, setRefused] = useState(false);
  /** True after the browser's device list was closed without a pick. */
  const [cancelled, setCancelled] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [startedAt, setStartedAt] = useState(0);

  // Load the bytes as soon as the choice is made, so the Flash click can open the
  // device chooser right away (browsers only allow that directly after a click).
  useEffect(() => {
    let current = true;
    setData(null);
    setAlso(null);
    setHash('');
    setLoadError('');
    setStatus('idle');
    setCancelled(false);
    setLog([]);
    const wanted = companionsFor(radio, build).filter((c) => c.found);
    Promise.all([fileBytes(file), ...wanted.map((c) => fileBytes(c.found!))])
      .then(async ([bytes, ...others]) => {
        const digest = file.sha256 ?? (await sha256Hex(bytes));
        if (!current) return;
        setData(bytes);
        setAlso(wanted.map((c, i) => ({ address: c.address, data: others[i] })));
        setHash(digest);
      })
      .catch((e: unknown) => current && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      current = false;
    };
    // The build and file objects, not their names: a file dropped again under the same
    // name is another file.
  }, [radio.id, build, file]);

  const api = apiFor(radio.method);
  const extras = filesFor(
    radio,
    build.files.map((f) => f.name),
  )
    .map((name) => build.files.find((f) => f.name === name)!)
    .filter((f) => f.name !== file.name);
  const companions = companionsFor(radio, build);
  const command = radio.manual.command?.replace('{file}', file.name).replace('{model}', radio.hidModel ?? '');
  const backup = backupFor(radio);
  const onWindows = navigator.userAgent.includes('Windows');
  /** What this browser last flashed onto this very radio, when its ID is known; else onto one of its model. */
  const onThisRadio = props.radioId ? lastFlashed.get(radio.id, props.radioId) : null;
  const before = onThisRadio ?? lastFlashed.get(radio.id);
  /** What every report about this flash says; the outcome and the message are added per link. */
  const about: Omit<ReportDraft, 'outcome'> = {
    step: 'flash',
    radio: { id: radio.id, name: radio.name },
    firmware: {
      label: build.label,
      file: [file.name, ...companions.filter((c) => c.found).map((c) => c.file)].join(' + '),
      sha256: hash,
      commit: build.sha,
      date: build.backup ? undefined : build.date,
      url: build.url,
    },
    backup: props.backupSummary,
    log,
  };

  /** Runs one flash attempt from the Flash button. */
  const flash = async () => {
    if (!data || !also) return;
    const lines: string[] = [];
    const phases = new Set<Progress['phase']>();
    const say = (line: string) => {
      lines.push(line);
      setLog([...lines]);
    };
    setMessage('');
    setCancelled(false);
    setLog([]);
    const paint = paintGate();
    let device: PickedDevice;
    try {
      device = await getDevice('flash');
    } catch (e) {
      if (isChooserCancel(e)) {
        setCancelled(true);
        return;
      }
      setWrote(false);
      setStatus('error');
      setMessage(e instanceof Error ? e.message : String(e));
      return;
    }
    setStatus('running');
    onBusy(true);
    setStartedAt(Date.now());
    setProgress({ phase: 'connect', done: 0, total: data.length });
    say(`Firmware: ${describeBuild(build)}`);
    if (build.url) say(`From: ${build.url}`);
    say(`Sending ${file.name} (${data.length} bytes) to ${radio.name}`);
    try {
      await flashDevice(
        radio,
        device,
        data,
        {
          log: say,
          sleep: (ms) => env.sleep(ms),
          progress: (p) => {
            phases.add(p.phase);
            if (paint(p)) setProgress(p);
          },
        },
        build.backup ?? null,
        also,
      );
      setProgress({ phase: 'done', done: 1, total: 1 });
      say('Finished.');
      lastFlashed.set(radio.id, {
        label: build.label,
        sha: build.sha,
        at: new Date().toISOString(),
        radioId: props.radioId ?? undefined,
      });
      setStatus('done');
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      // The radio may have dropped off; ask for it again next time.
      dropDevice();
      say(`Failed: ${text}`);
      setMessage(text);
      setRefused(e instanceof WrongRadioError);
      setWrote(beganWriting(phases, lines));
      setStatus('error');
    } finally {
      onBusy(false);
    }
  };

  /** A report that the radio did not start after a flash the page called done. */
  const notStarted: ReportDraft = {
    ...about,
    outcome: 'failed',
    error: 'The page said done, but the radio did not start OpenRTX.',
  };

  return (
    <div class="flex flex-col gap-4" data-testid="flash-step">
      <div class="flex items-center gap-4 rounded-box bg-base-200 p-4">
        <RadioArt id={radio.id} class="h-24 w-14 flex-none" />
        <div class="flex min-w-0 flex-col gap-1">
          <div class="text-lg font-medium">
            {build.label} for the {radio.name}
          </div>
          <div class="text-sm break-all text-base-content/80">
            <code>{file.name}</code> · {formatSize(file.size)}
            {hash && <> · SHA-256 {hash.slice(0, 12)}…</>}
          </div>
          <div class="text-sm text-base-content/80">
            <BuildFacts build={build} testid="flash-build" />
          </div>
          {build.backup && (
            <div class="text-sm text-primary" data-testid="restoring">
              This is a backup. Only restore it onto the radio it came from.
            </div>
          )}
          {companions.map((c) =>
            c.found ? (
              <div class="text-sm break-all text-base-content/80" key={c.file} data-testid="also-writes">
                <code>{c.file}</code> · {formatSize(c.found.size)} · the {c.what}, written at 0x
                {c.address.toString(16)} in the same run
              </div>
            ) : (
              <div class="text-sm text-warning" key={c.file} role="alert" data-testid="missing-companion">
                This build has no {c.file}. OpenRTX on the {radio.name} needs its {c.what} as well as{' '}
                {file.name}: without it the radio starts with a black screen. Use the build zip, which has
                both, unless this radio already runs OpenRTX.
              </div>
            ),
          )}
          {loadError && (
            <div class="text-warning" role="alert">
              {loadError}
            </div>
          )}
        </div>
      </div>

      {sameBuild(before, build) && status !== 'done' && (
        <Notice tone="info" testid="same-build">
          {build.label} is what this browser last flashed onto{' '}
          {onThisRadio ? 'this radio' : `a ${radio.name}`}, on {formatDate(before.at)}. Flashing it again
          changes nothing unless that flash went wrong.
        </Notice>
      )}

      {radio.flashNotes && (
        <ul class="flex list-disc flex-col gap-1 ps-5" data-testid="flash-notes">
          {radio.flashNotes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {radio.method === 'uf2-copy' ? (
        <>
          <p>Download the file and copy it onto the USB drive that appeared.</p>
          <div class={ACTIONS}>
            <Download file={file} primary />
          </div>
          <p class="text-sm text-muted">{radio.after}</p>
        </>
      ) : !supported ? (
        <Notice tone="info" testid="unsupported">
          This browser has no {API_NAME[api!]}, which the page needs to talk to this radio. Use Chrome or Edge
          on a computer, or flash it yourself with the file below.
        </Notice>
      ) : !allowed ? (
        <ExperimentalGate radio={radio} onTurnOn={() => props.onExperimental(true)} />
      ) : (
        <>
          {radio.verified ? (
            <p class="flex flex-wrap items-center gap-2 text-sm" data-testid="verified">
              <span class="badge badge-success badge-sm">Checked</span>
              <span>
                Checked on a real radio:{' '}
                {[radio.verified.version, radio.verified.platform, formatDate(radio.verified.date)]
                  .filter(Boolean)
                  .join(', ')}
                .
              </span>
            </p>
          ) : (
            <p class="flex flex-wrap items-center gap-2 text-sm" data-testid="experimental-note">
              <span class="badge badge-outline badge-warning badge-sm">Not checked yet</span>
              <span>Experimental flashing is on.</span>
              <button
                class="link link-primary"
                type="button"
                disabled={status === 'running'}
                data-testid="turn-off-experimental"
                onClick={() => props.onExperimental(false)}
              >
                Turn off
              </button>
            </p>
          )}
          {status === 'error' && (
            <Notice tone="error" role="alert" testid="flash-error">
              <p>{message}</p>
              {/* Some flashers say it themselves, in their own words. */}
              {!/nothing was sent/i.test(message) && (
                <p class="mt-1 text-sm" data-testid="flash-wrote">
                  {wrote
                    ? 'The radio was partly written. It may not start until a flash completes: put it in flashing mode again and try again.'
                    : 'Nothing was written to the radio.'}
                </p>
              )}
            </Notice>
          )}
          {status === 'done' && (
            <Notice tone="success" role="status" testid="done">
              <div class="flex flex-col gap-2">
                <p class="font-medium">
                  Done. The {radio.name} now holds{' '}
                  <span data-testid="done-build">{describeBuild(build)}</span>.
                </p>
                <p data-testid="after">
                  Next: {radio.after}
                  {build.backup ? '' : ' It should start OpenRTX.'}
                </p>
              </div>
            </Notice>
          )}
          {status === 'done' && (
            <ul class="flex list-disc flex-col gap-2 ps-5" data-testid="after-flash">
              <li>
                The{' '}
                <Out href={'https://openrtx.org/#/user_guide'} testid="after-guide">
                  users’ guide
                </Out>{' '}
                covers the screens, the menus and M17.
              </li>
              <li data-testid="if-not-starting">
                If the radio does not start: put it in flashing mode again and press “Flash again”. The way
                back is the manufacturer’s firmware, written with{' '}
                <Out href={radio.manual.url}>{radio.manual.tool}</Out>
                {backup.how === 'read' && backup.restorable
                  ? ', or a backup this page took: restore it from the Backups list below.'
                  : '.'}
              </li>
            </ul>
          )}
          {status !== 'running' && status !== 'done' && <ChooserHint radio={radio} />}
          {onWindows && api === 'usb' && status === 'idle' && (
            <p class="text-sm text-base-content/80" data-testid="windows-driver">
              On Windows the radio needs the WinUSB driver before the browser can see it. Install it once with{' '}
              <Out href="https://zadig.akeo.ie">Zadig</Out> while the radio is in flashing mode.
            </p>
          )}
          <div class={ACTIONS}>
            {status === 'done' && (
              <button
                class="btn h-auto min-h-(--size) py-2"
                type="button"
                data-testid="flash-another"
                onClick={props.onAnother}
              >
                Flash another {radio.name}
              </button>
            )}
            <button
              class={`btn ${status === 'done' ? 'btn-ghost' : 'btn-primary'}`}
              type="button"
              disabled={!data || !also || status === 'running'}
              data-testid="flash"
              onClick={() => void flash()}
            >
              {status === 'running' && (
                <span class="loading loading-spinner loading-sm" data-testid="spinner" />
              )}
              {status === 'running'
                ? 'Flashing…'
                : status === 'idle'
                  ? 'Connect and flash'
                  : status === 'error'
                    ? 'Try again'
                    : 'Flash again'}
            </button>
            {status === 'running' && (
              <span class="text-sm">Do not unplug or switch off the radio, and keep this tab open.</span>
            )}
          </div>
          {cancelled && <ChooserHelp radio={radio} purpose="flash" />}
          {status === 'done' &&
            (asksForSuccess(radio.verified !== null) ? (
              // Nobody has checked this radio yet: a "worked" report is what gets it checked.
              <div
                class="flex flex-col gap-2 rounded-box border border-base-300 p-4"
                data-testid="ask-worked"
              >
                <p>Did the radio start OpenRTX? Your answer helps get the {radio.name} checked.</p>
                <div class="flex flex-wrap items-center gap-2">
                  <ReportLink
                    report={{ ...about, outcome: 'worked' }}
                    label="Yes, report that it worked"
                    testid="report-worked"
                  />
                  <ReportLink report={notStarted} label="No, report a problem" testid="report-failed" />
                  <CopyReport report={{ ...about, outcome: 'worked' }} />
                </div>
                <ReportNote />
              </div>
            ) : (
              // A checked radio: more successes say nothing new.
              <p class="text-sm" data-testid="ask-problem">
                Not working?{' '}
                <ReportLink report={notStarted} label="Report a problem" testid="report-failed" plain />
              </p>
            ))}
          {/* Always in the same place among its neighbours, so the console stays open when the flash ends. */}
          {status !== 'idle' && (
            <Activity
              progress={progress}
              running={status === 'running'}
              failed={status === 'error'}
              log={log}
              startedAt={startedAt}
            />
          )}
          {status === 'error' && !refused && (
            <StillFailing
              radio={radio}
              purpose="flash"
              report={{ ...about, outcome: 'failed', error: message }}
            />
          )}
        </>
      )}

      {radio.method !== 'uf2-copy' && (
        // Folded while the page can do the flashing; open when it cannot, or usually cannot.
        <details
          class="collapse-arrow collapse border border-separator"
          data-testid="other-tool"
          open={!supported || !!radio.useInstead}
        >
          <summary class="collapse-title min-h-0 py-2 text-sm">Use another tool instead</summary>
          <div class="collapse-content flex flex-col gap-3">
            {radio.useInstead ? (
              <>
                <p>Download the .bin file and write it with one of these:</p>
                <OtherTools tools={radio.useInstead.tools} />
              </>
            ) : (
              <>
                <p>
                  Download the file and write it with <Out href={radio.manual.url}>{radio.manual.tool}</Out>.
                </p>
                {command && (
                  <pre
                    class="overflow-x-auto rounded-box bg-base-200 p-3 font-mono text-sm"
                    data-testid="command"
                  >
                    {command}
                  </pre>
                )}
                {radio.manual.windows && <p class="text-sm text-muted">{radio.manual.windows}</p>}
              </>
            )}
            <div class="flex flex-wrap items-center gap-2">
              <Download file={file} />
              {extras.map((f) => (
                <Download key={f.name} file={f} />
              ))}
            </div>
          </div>
        </details>
      )}
    </div>
  );
}
