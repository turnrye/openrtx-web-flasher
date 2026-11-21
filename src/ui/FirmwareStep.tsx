// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Step 2: choose what to flash. Three choices: the current release, the development
 * build (both ship with the site), or "Other", which opens one panel for a past
 * release, a CI build of any branch, pull request or fork, or a file from this
 * computer.
 */
import { useEffect, useState } from 'preact/hooks';
import { buildFromLocalFile, fileForRadio, isZip, type Build, type Manifest } from '../firmware/builds.ts';
import { artifactFor, buildFromRun, findRun, parseQuery, type CiRun } from '../firmware/github.ts';
import type { Radio } from '../radios.ts';
import { lastRepo } from '../settings.ts';
import { DropZone, formatDate, formatSize } from './common.tsx';

const DEFAULT_REPO = 'OpenRTX/OpenRTX';

/** The ways to get firmware under "Other". */
type Pane = 'past' | 'ci' | 'file';

interface Props {
  radio: Radio;
  /** Null while loading; `builds` is empty when the site was built without firmware. */
  manifest: Manifest | null;
  build: Build | null;
  onBuild: (build: Build | null) => void;
}

/** Why `build` cannot be flashed onto `radio`; empty when it can. */
function problemWith(radio: Radio, build: Build): string {
  if (fileForRadio(radio, build)) return '';
  if (!build.backup) {
    const names = build.files.map((f) => f.name).join(', ') || 'nothing';
    return `${build.label} has no file for the ${radio.name}. It contains: ${names}.`;
  }
  if (build.backup.radio !== radio.id) {
    return `This is a backup of a ${build.backup.model}, not of the ${radio.name}.`;
  }
  return build.backup.source === 'original-firmware'
    ? 'This backup was read through the radio’s original firmware. It is the record of what the radio held (channels, settings, factory data); this page cannot write it back.'
    : 'This backup is incomplete, so the page will not write it back.';
}

/** What was loaded from a file or a CI build, with a way to choose again. */
function Loaded({ radio, build, onAgain }: { radio: Radio; build: Build; onAgain: () => void }) {
  const file = fileForRadio(radio, build);
  const problem = problemWith(radio, build);
  const inside = file && file.name !== build.label ? `${file.name} · ` : '';
  return (
    <>
      <div class={`loaded${problem ? ' bad' : ''}`} role="status" data-testid="loaded">
        <span class={problem ? 'error' : 'ok-text'}>{problem ? 'Not usable' : 'Loaded'}</span>
        <code>{build.label}</code>
        {file && (
          <span class="muted small">
            {inside}
            {formatSize(file.size)}
          </span>
        )}
        <button class="linkish" type="button" data-testid="choose-another" onClick={onAgain}>
          Choose another
        </button>
      </div>
      {problem && (
        <p class="error" role="alert" data-testid={build.backup ? 'backup-not-flashable' : 'no-file'}>
          {problem}
        </p>
      )}
    </>
  );
}

/** Builds of a branch, pull request or fork, made by GitHub CI. */
function CiPane({ radio, build, onBuild }: Props) {
  const [repo, setRepo] = useState(lastRepo.get());
  const [ref, setRef] = useState('');
  const [run, setRun] = useState<CiRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const artifact = run ? artifactFor(run, radio.id) : undefined;
  const loaded = build?.kind === 'ci' ? build : null;

  /** Reports a failed lookup or download. */
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  /** Looks the build up. */
  const find = async () => {
    const query = parseQuery(repo, ref, DEFAULT_REPO);
    setError('');
    setRun(null);
    onBuild(null);
    if (!query) return setError('Write the repository as owner/name, for example OpenRTX/OpenRTX.');
    setBusy(true);
    try {
      lastRepo.set(repo);
      setRun(await findRun(query));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  /** Takes the zip the user downloaded from nightly.link. */
  const takeZip = async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!run || !isZip(bytes)) {
      return setError(`${file.name} is not the build zip. Download it with the link above first.`);
    }
    setError('');
    onBuild(buildFromRun(run, bytes));
  };

  return (
    <div data-testid="ci-panel">
      <form
        class="fields"
        onSubmit={(e) => {
          e.preventDefault();
          void find();
        }}
      >
        <label class="field">
          Repository
          <input
            value={repo}
            placeholder={DEFAULT_REPO}
            spellcheck={false}
            autocapitalize="off"
            data-testid="ci-repo"
            onInput={(e) => setRepo(e.currentTarget.value)}
          />
        </label>
        <label class="field">
          Branch or pull request
          <input
            value={ref}
            placeholder="my-branch, #588 or a GitHub link"
            spellcheck={false}
            autocapitalize="off"
            data-testid="ci-ref"
            onInput={(e) => setRef(e.currentTarget.value)}
          />
        </label>
        <button class="btn" type="submit" disabled={busy} data-testid="ci-find">
          {busy ? 'Looking…' : 'Find build'}
        </button>
      </form>
      <p class="muted small">
        Leave the repository empty for OpenRTX itself, or name a fork that builds with the project’s GitHub
        workflow.
      </p>
      {run && (
        <div data-testid="ci-result">
          <p>
            Found <a href={run.url}>{run.label}</a>{' '}
            <span class="muted">
              · {run.sha.slice(0, 7)} · {formatDate(run.date)}
            </span>
          </p>
          {!artifact && <p class="error">This build has no file for the {radio.name}.</p>}
          {artifact?.expired && (
            <p class="error">GitHub has deleted this build’s files. Re-run the workflow.</p>
          )}
          {artifact && !artifact.expired && !loaded && (
            <>
              <p class="small">
                Browsers cannot fetch GitHub build files for a page, so there are two steps:
              </p>
              <ol class="small">
                <li>
                  <a href={artifact.downloadUrl} data-testid="ci-download">
                    Download {artifact.name}.zip
                  </a>{' '}
                  <span class="muted">({formatSize(artifact.size)})</span>
                </li>
                <li>Drop it here.</li>
              </ol>
              <DropZone onFile={(f) => void takeZip(f)} accept=".zip">
                Drop {artifact.name}.zip here
              </DropZone>
            </>
          )}
        </div>
      )}
      {loaded && <Loaded radio={radio} build={loaded} onAgain={() => onBuild(null)} />}
      {error && (
        <p class="error" role="alert" data-testid="ci-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** A firmware file, a build zip or a backup from this computer. */
function FilePane({ radio, build, onBuild }: Props) {
  const [error, setError] = useState('');
  const loaded = build?.kind === 'local' ? build : null;

  /** Loads the file the user picked or dropped. */
  const take = async (file: File) => {
    setError('');
    try {
      onBuild(await buildFromLocalFile(file));
    } catch (e) {
      // A damaged backup says what is wrong with it; anything else could not be read.
      setError(e instanceof Error && /backup/i.test(e.message) ? e.message : `Could not read ${file.name}.`);
    }
  };

  return (
    <div data-testid="file-panel">
      {loaded ? (
        <Loaded radio={radio} build={loaded} onAgain={() => onBuild(null)} />
      ) : (
        <DropZone onFile={(f) => void take(f)}>Drop a firmware file, a build zip or a backup here</DropZone>
      )}
      {error && (
        <p class="error" role="alert" data-testid="file-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** Step 2 of the page. */
export function FirmwareStep({ radio, manifest, build, onBuild }: Props) {
  const builds = manifest?.builds ?? [];
  const releases = builds.filter((b) => b.kind === 'release');
  const current = releases.at(0);
  const past = releases.slice(1);
  const dev = builds.find((b) => b.kind === 'master');
  const currentFile = fileForRadio(radio, current);
  const devFile = fileForRadio(radio, dev);
  const pastWithFile = past.filter((b) => fileForRadio(radio, b));

  /** True for the two builds that have a tile of their own. */
  const onTile = (b: Build | null) => !!b && (b.id === current?.id || b.id === dev?.id);
  const [otherOpen, setOtherOpen] = useState(!!build && !onTile(build));
  const [pane, setPane] = useState<Pane>('past');

  // A build that arrives from elsewhere (a file dropped on the page, a backup chosen to
  // restore) shows up where it would have been chosen by hand.
  useEffect(() => {
    if (!build || onTile(build)) return;
    setOtherOpen(true);
    setPane(build.kind === 'release' ? 'past' : build.kind === 'ci' ? 'ci' : 'file');
  }, [build?.id]);

  /** Opens "Other", on a way that has something to offer for this radio. */
  const openOther = () => {
    if (otherOpen) return;
    setOtherOpen(true);
    if (pane === 'past' && pastWithFile.length === 0) setPane('ci');
    if (onTile(build)) onBuild(null);
  };

  /** Switches the way under "Other"; what was chosen the other way is dropped. */
  const switchPane = (next: Pane) => {
    if (next === pane) return;
    setPane(next);
    onBuild(null);
  };

  const chosen = build && fileForRadio(radio, build);
  const waiting = manifest === null ? 'Loading…' : 'Not bundled with this copy of the site';

  return (
    <>
      <div class="tiles" data-testid="builds">
        <button
          class="tile"
          type="button"
          disabled={!currentFile}
          aria-pressed={!otherOpen && !!current && build?.id === current.id}
          data-testid={current ? `build-${current.id}` : 'build-none'}
          onClick={() => {
            setOtherOpen(false);
            onBuild(current!);
          }}
        >
          <span class="name">Current release</span>
          <span class="what">
            {currentFile ? current!.label : current ? 'None for this radio yet' : waiting}
          </span>
          <span class="more">
            {currentFile
              ? `${formatDate(current!.date)} · ${formatSize(currentFile.size)}`
              : current && devFile
                ? 'Use the development build'
                : ''}
          </span>
        </button>
        <button
          class="tile"
          type="button"
          disabled={!devFile}
          aria-pressed={!otherOpen && !!dev && build?.id === dev.id}
          data-testid={dev ? `build-${dev.id}` : 'build-nodev'}
          onClick={() => {
            setOtherOpen(false);
            onBuild(dev!);
          }}
        >
          <span class="name">Development build</span>
          <span class="what">
            {devFile
              ? `${dev!.label}${dev!.sha ? ` · ${dev!.sha.slice(0, 7)}` : ''}`
              : dev
                ? 'Not built for this radio'
                : waiting}
          </span>
          <span class="more">{devFile ? `${formatDate(dev!.date)} · newest changes, less tested` : ''}</span>
        </button>
        <button
          class="tile"
          type="button"
          aria-pressed={otherOpen}
          aria-expanded={otherOpen}
          aria-controls="firmware-other"
          data-testid="open-other"
          onClick={openOther}
        >
          <span class="name">Other</span>
          <span class="what">{otherOpen && chosen ? build.label : 'Choose…'}</span>
          <span class="more">A past release, a branch, a pull request, a fork, or a file</span>
        </button>
      </div>

      {otherOpen && (
        <div class="panel" id="firmware-other" data-testid="other-panel">
          <div class="seg" role="group" aria-label="Where the firmware comes from">
            <button
              type="button"
              aria-pressed={pane === 'past'}
              data-testid="open-past"
              onClick={() => switchPane('past')}
            >
              Past release
            </button>
            <button
              type="button"
              aria-pressed={pane === 'ci'}
              data-testid="open-ci"
              onClick={() => switchPane('ci')}
            >
              Branch or pull request
            </button>
            <button
              type="button"
              aria-pressed={pane === 'file'}
              data-testid="open-local"
              onClick={() => switchPane('file')}
            >
              File
            </button>
          </div>

          <div class="pane">
            {pane === 'past' &&
              (pastWithFile.length > 0 ? (
                <div class="fields">
                  <label class="field">
                    Release
                    <select
                      data-testid="past-release"
                      value={build?.kind === 'release' && !onTile(build) ? build.id : ''}
                      onChange={(e) => onBuild(past.find((b) => b.id === e.currentTarget.value) ?? null)}
                    >
                      <option value="">Choose a release…</option>
                      {past.map((b) => (
                        <option key={b.id} value={b.id} disabled={!fileForRadio(radio, b)}>
                          {b.label} · {formatDate(b.date)}
                          {fileForRadio(radio, b) ? '' : ' · not built for this radio'}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              ) : (
                <p class="muted" data-testid="no-past">
                  No earlier release has a build for the {radio.name}.
                </p>
              ))}
            {pane === 'ci' && <CiPane radio={radio} manifest={manifest} build={build} onBuild={onBuild} />}
            {pane === 'file' && (
              <FilePane radio={radio} manifest={manifest} build={build} onBuild={onBuild} />
            )}
          </div>
        </div>
      )}

      {build && !chosen && !(otherOpen && build.kind !== 'release') && (
        <p class="panel error" role="alert" data-testid={build.backup ? 'backup-not-flashable' : 'no-file'}>
          {problemWith(radio, build)}
        </p>
      )}
    </>
  );
}
