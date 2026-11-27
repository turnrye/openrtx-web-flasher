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
import type { Progress, Segment } from '../flash/types.ts';
import { apiFor, filesFor, type Radio } from '../radios.ts';
import { Activity, paintGate } from './Activity.tsx';
import { formatSize } from './common.tsx';
import { ExperimentalGate } from './Experimental.tsx';
import { RadioArt } from './RadioArt.tsx';
import { CopyReport, ReportLink, ReportNote, type ReportDraft } from './Report.tsx';
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
  /** Whether talking to this radio is allowed: it was checked on hardware, or experimental flashing is on. */
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
}

const API_NAME = { usb: 'WebUSB', serial: 'Web Serial', hid: 'WebHID' } as const;

/** A download link for a mirrored file, or a button for one that only exists in memory. */
function Download({ file, primary }: { file: BuildFile; primary?: boolean }) {
  const cls = `btn${primary ? ' primary' : ''}`;
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
  const onWindows = navigator.userAgent.includes('Windows');
  /** What every report about this flash says; the outcome and the message are added per link. */
  const about: Omit<ReportDraft, 'outcome'> = {
    step: 'flash',
    radio: { id: radio.id, name: radio.name },
    firmware: {
      label: build.label,
      file: [file.name, ...companions.filter((c) => c.found).map((c) => c.file)].join(' + '),
      sha256: hash,
    },
    backup: props.backupSummary,
    log,
  };

  /** Runs one flash attempt from the Flash button. */
  const flash = async () => {
    if (!data || !also) return;
    const lines: string[] = [];
    const say = (line: string) => {
      lines.push(line);
      setLog([...lines]);
    };
    setMessage('');
    setLog([]);
    const paint = paintGate();
    let device: PickedDevice;
    try {
      device = await getDevice('flash');
    } catch (e) {
      if (isChooserCancel(e)) return;
      setStatus('error');
      setMessage(e instanceof Error ? e.message : String(e));
      return;
    }
    setStatus('running');
    onBusy(true);
    setStartedAt(Date.now());
    setProgress({ phase: 'connect', done: 0, total: data.length });
    say(`Flashing ${file.name} (${data.length} bytes) to ${radio.name}`);
    try {
      await flashDevice(
        radio,
        device,
        data,
        {
          log: say,
          sleep: (ms) => env.sleep(ms),
          progress: (p) => {
            if (paint(p)) setProgress(p);
          },
        },
        build.backup ?? null,
        also,
      );
      setProgress({ phase: 'done', done: 1, total: 1 });
      say('Finished.');
      setStatus('done');
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      // The radio may have dropped off; ask for it again next time.
      dropDevice();
      say(`Failed: ${text}`);
      setMessage(text);
      setStatus('error');
    } finally {
      onBusy(false);
    }
  };

  return (
    <div data-testid="flash-step">
      <div class="summary">
        <RadioArt id={radio.id} />
        <div>
          <div class="what">
            {build.label} for the {radio.name}
          </div>
          <div class="muted small">
            <code>{file.name}</code> · {formatSize(file.size)}
            {hash && <> · SHA-256 {hash.slice(0, 12)}…</>}
          </div>
          {build.backup && (
            <div class="gold small" data-testid="restoring">
              This is a backup. Only restore it onto the radio it came from.
            </div>
          )}
          {companions.map((c) =>
            c.found ? (
              <div class="muted small" key={c.file} data-testid="also-writes">
                <code>{c.file}</code> · {formatSize(c.found.size)} · the {c.what}, written at 0x
                {c.address.toString(16)} in the same run
              </div>
            ) : (
              <div class="error small" key={c.file} role="alert" data-testid="missing-companion">
                This build has no {c.file}. OpenRTX on the {radio.name} needs its {c.what} as well as{' '}
                {file.name}: without it the radio starts with a black screen. Use the build zip, which has
                both, unless this radio already runs OpenRTX.
              </div>
            ),
          )}
          {loadError && (
            <div class="error" role="alert">
              {loadError}
            </div>
          )}
        </div>
      </div>

      <div class="block">
        {radio.flashNotes && (
          <ul data-testid="flash-notes">
            {radio.flashNotes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
        {radio.method === 'uf2-copy' ? (
          <>
            <p>Download the file and copy it onto the USB drive that appeared.</p>
            <div class="actions">
              <Download file={file} primary />
            </div>
            <p class="muted small">{radio.after}</p>
          </>
        ) : !supported ? (
          <p data-testid="unsupported">
            This browser has no {API_NAME[api!]}, which the page needs to talk to this radio. Use Chrome or
            Edge on a computer, or flash it yourself with the file below.
          </p>
        ) : !allowed ? (
          <ExperimentalGate radio={radio} onTurnOn={() => props.onExperimental(true)} />
        ) : (
          <>
            {radio.verified ? (
              <p class="ok-text small" data-testid="verified">
                Checked on a real radio:{' '}
                {[radio.verified.version, radio.verified.platform, radio.verified.date]
                  .filter(Boolean)
                  .join(', ')}
                .
              </p>
            ) : (
              <p class="error small" data-testid="experimental-note">
                Experimental: not yet checked on a real {radio.name}.{' '}
                <button
                  class="linkish"
                  type="button"
                  disabled={status === 'running'}
                  data-testid="turn-off-experimental"
                  onClick={() => props.onExperimental(false)}
                >
                  Turn off
                </button>
              </p>
            )}
            {onWindows && api === 'usb' && (
              <p class="muted small">
                On Windows the radio needs the WinUSB driver before Chrome can see it. Install it once with
                Zadig while the radio is in flashing mode.
              </p>
            )}
            <div class="actions">
              <button
                class="btn primary"
                type="button"
                disabled={!data || !also || status === 'running'}
                data-testid="flash"
                onClick={() => void flash()}
              >
                {status === 'running' && <span class="spinner" aria-hidden="true" />}
                {status === 'running' ? 'Flashing…' : status === 'idle' ? 'Connect and flash' : 'Flash again'}
              </button>
              {status === 'running' && <span class="muted">Do not unplug or switch off the radio.</span>}
            </div>
            {status !== 'idle' && (
              <Activity
                progress={progress}
                running={status === 'running'}
                failed={status === 'error'}
                log={log}
                startedAt={startedAt}
              />
            )}
            {status === 'done' && (
              <p class="ok-text" role="status" data-testid="done">
                Done. {radio.after}
              </p>
            )}
            {status === 'done' &&
              (asksForSuccess(radio.verified !== null) ? (
                // Nobody has checked this radio yet: a "worked" report is what gets it checked.
                <div class="ask" data-testid="ask-worked">
                  <p>Did the radio start OpenRTX? Your answer helps get the {radio.name} checked.</p>
                  <div class="actions">
                    <ReportLink
                      report={{ ...about, outcome: 'worked' }}
                      label="Yes, report that it worked"
                      testid="report-worked"
                    />
                    <ReportLink
                      report={{
                        ...about,
                        outcome: 'failed',
                        error: 'The page said done, but the radio did not start OpenRTX.',
                      }}
                      label="No, report a problem"
                      testid="report-failed"
                    />
                    <CopyReport report={{ ...about, outcome: 'worked' }} />
                  </div>
                  <ReportNote />
                </div>
              ) : (
                // A checked radio: more successes say nothing new.
                <p class="small" data-testid="ask-problem">
                  Not working?{' '}
                  <ReportLink
                    report={{
                      ...about,
                      outcome: 'failed',
                      error: 'The page said done, but the radio did not start OpenRTX.',
                    }}
                    label="Report a problem"
                    testid="report-failed"
                    plain
                  />
                </p>
              ))}
            {status === 'error' && (
              <>
                <p class="error" role="alert" data-testid="flash-error">
                  {message} Put the radio back in flashing mode and try again.
                </p>
                <div class="actions">
                  <ReportLink
                    report={{ ...about, outcome: 'failed', error: message }}
                    label="Report this"
                    testid="report-failed"
                  />
                  <CopyReport report={{ ...about, outcome: 'failed', error: message }} />
                </div>
                <ReportNote />
              </>
            )}
          </>
        )}

        {radio.method !== 'uf2-copy' && (
          // Folded while the page can do the flashing; open when it cannot, or usually cannot.
          <details class="more" data-testid="other-tool" open={!supported || !!radio.useInstead}>
            <summary>Use another tool instead</summary>
            {radio.useInstead ? (
              <>
                <p>Download the .bin file and write it with one of these:</p>
                <OtherTools tools={radio.useInstead.tools} />
              </>
            ) : (
              <>
                <p>
                  Download the file and write it with <a href={radio.manual.url}>{radio.manual.tool}</a>.
                </p>
                {command && <pre class="command">{command}</pre>}
                {radio.manual.windows && <p class="muted small">{radio.manual.windows}</p>}
              </>
            )}
            <div class="actions">
              <Download file={file} />
              {extras.map((f) => (
                <Download key={f.name} file={f} />
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
