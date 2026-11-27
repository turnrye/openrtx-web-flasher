// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Step 2: choose what to flash. Three choices: the current release, the development
 * build (both ship with the site), or "Other", which opens one panel for a past
 * release, a CI build of any branch, pull request or fork, or a file from this
 * computer.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { buildFromLocalFile, fileForRadio, isZip, type Build, type Manifest } from '../firmware/builds.ts';
import {
  artifactFor,
  buildFromRun,
  checkZip,
  findRun,
  parseQuery,
  type CiRun,
  type ZipCheck,
} from '../firmware/github.ts';
import type { Radio } from '../radios.ts';
import { lastFlashed, lastRepo } from '../settings.ts';
import { BuildFacts, shortCommit } from './BuildFacts.tsx';
import { DropZone, formatDate, formatDateTime, formatSize, Notice, Out } from './common.tsx';

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
function Loaded(props: { radio: Radio; build: Build; onAgain: () => void; children?: ComponentChildren }) {
  const { radio, build } = props;
  const file = fileForRadio(radio, build);
  const problem = problemWith(radio, build);
  const inside = file && file.name !== build.label ? `${file.name} · ` : '';
  return (
    <>
      <div
        class={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-box border p-3 ${problem ? 'border-warning' : 'border-success'}`}
        role="status"
        data-testid="loaded"
      >
        <span class={`badge badge-sm ${problem ? 'badge-warning' : 'badge-success'}`}>
          {problem ? 'Not usable' : 'Loaded'}
        </span>
        <code class="break-all">{build.label}</code>
        {file && (
          <span class="text-sm break-all text-base-content/80">
            {inside}
            {formatSize(file.size)}
          </span>
        )}
        <button
          class="btn btn-ghost btn-sm ms-auto"
          type="button"
          data-testid="choose-another"
          onClick={props.onAgain}
        >
          Choose another
        </button>
        {props.children}
      </div>
      {problem && (
        <Notice tone="warning" role="alert" testid={build.backup ? 'backup-not-flashable' : 'no-file'}>
          {problem}
        </Notice>
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
  /** How the zip that was dropped compares with the one GitHub lists for the build. */
  const [check, setCheck] = useState<ZipCheck | null>(null);
  const artifact = run ? artifactFor(run, radio.id) : undefined;
  const loaded = build?.kind === 'ci' ? build : null;

  /** Reports a failed lookup or download. */
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  /** Looks the build up. */
  const find = async () => {
    const query = parseQuery(repo, ref, DEFAULT_REPO);
    setError('');
    setRun(null);
    setCheck(null);
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

  /**
   * Takes the zip the user downloaded from nightly.link. It must be the one that was
   * looked up: a zip of another build would be flashed under this build's name.
   */
  const takeZip = async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!run || !artifact || !isZip(bytes)) {
      return setError(`${file.name} is not the build zip. Download it with the link above first.`);
    }
    const verdict = await checkZip(artifact, bytes);
    if (verdict === 'mismatch') {
      return setError(
        `${file.name} is not the zip of ${run.label}: its SHA-256 is not the one GitHub lists for ${artifact.name}.zip of that build. It was not loaded. Download the zip again with the link above, and drop that one.`,
      );
    }
    setError('');
    setCheck(verdict);
    onBuild(buildFromRun(run, bytes));
  };

  return (
    <div class="flex flex-col gap-4" data-testid="ci-panel">
      <form
        class="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void find();
        }}
      >
        <label class="flex min-w-0 flex-1 basis-56 flex-col gap-1 text-sm">
          Repository
          <input
            class="input w-full"
            value={repo}
            placeholder={DEFAULT_REPO}
            spellcheck={false}
            autocapitalize="off"
            data-testid="ci-repo"
            onInput={(e) => setRepo(e.currentTarget.value)}
          />
        </label>
        <label class="flex min-w-0 flex-1 basis-56 flex-col gap-1 text-sm">
          Branch or pull request
          <input
            class="input w-full"
            value={ref}
            placeholder="my-branch, #588 or a GitHub link"
            spellcheck={false}
            autocapitalize="off"
            data-testid="ci-ref"
            onInput={(e) => setRef(e.currentTarget.value)}
          />
        </label>
        <button class="btn btn-primary" type="submit" disabled={busy} data-testid="ci-find">
          {busy && <span class="loading loading-spinner loading-sm" />}
          {busy ? 'Looking…' : 'Find build'}
        </button>
      </form>
      <p class="text-sm text-muted">
        Leave the repository empty for OpenRTX itself, or name a fork that builds with the project’s GitHub
        workflow.
      </p>
      {run && (
        <div class="flex flex-col gap-3" data-testid="ci-result">
          <p>
            Found <Out href={run.url}>{run.label}</Out>{' '}
            <span class="text-base-content/80">
              · commit <code>{shortCommit(run.sha)}</code> · built {formatDateTime(run.date)}
            </span>
          </p>
          {!artifact && (
            <Notice tone="warning" role="alert">
              This build has no file for the {radio.name}.
            </Notice>
          )}
          {artifact?.expired && (
            <Notice tone="warning" role="alert" testid="ci-expired">
              GitHub keeps a build’s files for a limited time and has deleted these. Push to the branch again
              or re-run the workflow to get new ones.
            </Notice>
          )}
          {artifact && !artifact.expired && !loaded && (
            <>
              <p class="text-sm">
                Browsers cannot fetch GitHub build files for a page, so there are two steps:
              </p>
              <ol class="flex list-decimal flex-col gap-1 ps-5 text-sm">
                <li>
                  <Out href={artifact.downloadUrl} testid="ci-download">
                    Download {artifact.name}.zip
                  </Out>{' '}
                  <span class="text-muted">({formatSize(artifact.size)}, opens in a new tab)</span>
                </li>
                <li>Drop it here. The page checks that it is the zip of this build.</li>
              </ol>
              <DropZone onFile={(f) => void takeZip(f)} accept=".zip">
                Drop {artifact.name}.zip here
              </DropZone>
            </>
          )}
        </div>
      )}
      {loaded && (
        <Loaded radio={radio} build={loaded} onAgain={() => onBuild(null)}>
          {check === 'match' && (
            <span class="basis-full text-sm text-success" data-testid="ci-checked">
              Checked: this is the zip GitHub lists for the build (SHA-256).
            </span>
          )}
          {check === 'unknown' && (
            <span class="basis-full text-sm text-warning" data-testid="ci-unchecked">
              Could not be checked: GitHub lists no SHA-256 for this build’s zip, so the page cannot tell
              whether this is it.
            </span>
          )}
        </Loaded>
      )}
      {error && (
        <Notice tone="warning" role="alert" testid="ci-error">
          {error}
        </Notice>
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
    <div class="flex flex-col gap-4" data-testid="file-panel">
      {loaded ? (
        <Loaded radio={radio} build={loaded} onAgain={() => onBuild(null)} />
      ) : (
        <DropZone onFile={(f) => void take(f)}>Drop a firmware file, a build zip or a backup here</DropZone>
      )}
      {error && (
        <Notice tone="warning" role="alert" testid="file-error">
          {error}
        </Notice>
      )}
    </div>
  );
}

/**
 * One of the three choices: a card with the choice as its one button, which fills the
 * card, and a link laid over the button's foot (a link cannot sit inside a button).
 */
function Tile(props: {
  name: string;
  what: string;
  more: string;
  pressed: boolean;
  disabled?: boolean;
  testid: string;
  onClick: () => void;
  /** A word on the card's corner, such as "Recommended". */
  badge?: string;
  /** Under the button: a link to the build's page. */
  children?: ComponentChildren;
  /** For the card that opens a panel: the panel's id and whether it is open. */
  controls?: string;
}) {
  const { pressed, disabled } = props;
  return (
    <div
      class={`card card-border relative motion-safe:transition-colors ${
        pressed
          ? 'border-secondary bg-secondary/15 ring-1 ring-secondary'
          : disabled
            ? 'border-separator opacity-60'
            : 'border-base-300 bg-base-200/50 hover:bg-base-200'
      }`}
    >
      <button
        class={`card-body gap-1 rounded-box p-4 text-start enabled:cursor-pointer ${props.children ? 'pb-11' : ''}`}
        type="button"
        disabled={disabled}
        aria-pressed={pressed}
        aria-expanded={props.controls ? pressed : undefined}
        aria-controls={props.controls}
        data-testid={props.testid}
        onClick={props.onClick}
      >
        <span class="flex flex-wrap items-center gap-2">
          <span class="card-title text-base font-medium">{props.name}</span>
          {props.badge && <span class="badge badge-primary badge-sm">{props.badge}</span>}
        </span>
        <span class="text-lg break-all text-primary">{props.what}</span>
        <span class="text-sm text-base-content/80">{props.more}</span>
      </button>
      {props.children && <div class="absolute start-4 bottom-3 text-sm">{props.children}</div>}
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
  const pastChosen = build?.kind === 'release' && !onTile(build) ? build : null;
  const flashed = lastFlashed.get(radio.id);
  /** One of the three ways under "Other", as a button of the group. */
  const paneButton = (id: Pane, testid: string, label: string) => (
    <button
      class={`btn join-item ${pane === id ? 'btn-active border-secondary' : ''}`}
      type="button"
      aria-pressed={pane === id}
      data-testid={testid}
      onClick={() => switchPane(id)}
    >
      {label}
    </button>
  );

  return (
    <>
      {flashed && (
        <p class="text-sm text-base-content/80" data-testid="last-flashed">
          Last flashed here onto a {radio.name}: {flashed.label}
          {flashed.sha ? ` (${shortCommit(flashed.sha)})` : ''}, {formatDate(flashed.at)}.
        </p>
      )}
      <div class="grid gap-3 sm:grid-cols-3" data-testid="builds">
        <Tile
          name="Current release"
          badge={currentFile ? 'Recommended' : undefined}
          what={currentFile ? current!.label : current ? 'None for this radio yet' : waiting}
          more={
            currentFile
              ? `${formatDate(current!.date)} · ${formatSize(currentFile.size)}`
              : current && devFile
                ? 'Use the development build'
                : ''
          }
          disabled={!currentFile}
          pressed={!otherOpen && !!current && build?.id === current.id}
          testid={current ? `build-${current.id}` : 'build-none'}
          onClick={() => {
            setOtherOpen(false);
            onBuild(current!);
          }}
        >
          {currentFile && current?.url && (
            <Out href={current.url} testid="release-notes">
              Release notes
            </Out>
          )}
        </Tile>
        <Tile
          name="Development build"
          what={
            devFile
              ? `${dev!.label}${dev!.sha ? ` · ${shortCommit(dev!.sha)}` : ''}`
              : dev
                ? 'Not built for this radio'
                : waiting
          }
          more={devFile ? `${formatDateTime(dev!.date)} · newest changes, less tested` : ''}
          disabled={!devFile}
          pressed={!otherOpen && !!dev && build?.id === dev.id}
          testid={dev ? `build-${dev.id}` : 'build-nodev'}
          onClick={() => {
            setOtherOpen(false);
            onBuild(dev!);
          }}
        >
          {devFile && dev?.url && <Out href={dev.url}>CI run</Out>}
        </Tile>
        <Tile
          name="Other"
          what={otherOpen && chosen ? build.label : 'Choose…'}
          more="A past release, a branch, a pull request, a fork, or a file"
          pressed={otherOpen}
          controls="firmware-other"
          testid="open-other"
          onClick={openOther}
        />
      </div>

      {otherOpen && (
        <div
          class="flex flex-col gap-4 rounded-box border border-base-300 p-4"
          id="firmware-other"
          data-testid="other-panel"
        >
          <div class="join max-sm:join-vertical" role="group" aria-label="Where the firmware comes from">
            {paneButton('past', 'open-past', 'Past release')}
            {paneButton('ci', 'open-ci', 'Branch or pull request')}
            {paneButton('file', 'open-local', 'File')}
          </div>

          {pane === 'past' &&
            (pastWithFile.length > 0 ? (
              <div class="flex flex-col gap-2">
                <label class="flex max-w-md flex-col gap-1 text-sm">
                  Release
                  <select
                    class="select w-full"
                    data-testid="past-release"
                    value={pastChosen?.id ?? ''}
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
                {pastChosen && (
                  <p class="text-sm text-base-content/80">
                    <BuildFacts build={pastChosen} />
                  </p>
                )}
              </div>
            ) : (
              <p class="text-muted" data-testid="no-past">
                No earlier release has a build for the {radio.name}.
              </p>
            ))}
          {pane === 'ci' && <CiPane radio={radio} manifest={manifest} build={build} onBuild={onBuild} />}
          {pane === 'file' && <FilePane radio={radio} manifest={manifest} build={build} onBuild={onBuild} />}
        </div>
      )}

      {build && !chosen && !(otherOpen && build.kind !== 'release') && (
        <Notice tone="warning" role="alert" testid={build.backup ? 'backup-not-flashable' : 'no-file'}>
          {problemWith(radio, build)}
        </Notice>
      )}
    </>
  );
}
