// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Where the command line gets firmware.
 *
 * The page may only read what was copied next to it when it was built: browsers keep it
 * from GitHub's release files and CI zips. Nothing keeps Node from them, so builds come
 * straight from GitHub, and what was downloaded is kept in the per-user cache in the
 * layout scripts/mirror-firmware.mjs uses.
 *
 * What needs a GitHub login and what does not:
 *   - listing releases, branches, pull requests and their builds: no login, but only 60
 *     lookups an hour from one address; a GITHUB_TOKEN raises that
 *   - release files: no login
 *   - the zip of a CI build: GitHub gives it to logged-in users only. With GITHUB_TOKEN it
 *     comes from GitHub; without, from nightly.link, a service that passes the same zip
 *     on without a login.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { buildFromLocalFile, isZip, sha256Hex, type Build, type BuildFile } from '../src/firmware/builds.ts';
import {
  api,
  artifactFor,
  buildFromRun,
  findRun,
  GithubError,
  parseQuery,
  type BuildQuery,
  type CiRun,
  type Fetcher,
} from '../src/firmware/github.ts';
import type { Radio } from '../src/radios.ts';

/** Where firmware comes from unless --repo says otherwise. */
export const DEFAULT_REPO = 'OpenRTX/OpenRTX';

const API = 'https://api.github.com';

/** What fetching firmware needs from its surroundings. */
export interface Source {
  fetch: Fetcher;
  /** A GitHub token, when the person has set one. */
  token?: string;
  /** The per-user cache folder; null keeps nothing. */
  cache: string | null;
  /** Says what is being downloaded. */
  say(line: string): void;
}

/** A release as GitHub's API describes it. */
interface ApiRelease {
  tag_name: string;
  draft: boolean;
  published_at: string;
  html_url: string;
  assets: { name: string; size: number; browser_download_url: string; digest?: string | null }[];
}

/** Firmware files as OpenRTX names them, minus the emulator: the rule of scripts/mirror-firmware.mjs. */
function isFirmware(name: string): boolean {
  return /^openrtx_[a-z0-9]+[_.]/i.test(name) && !/^openrtx_linux/i.test(name);
}

/** A fetch for GitHub: says who asks and, to the API only, logs in with the token. */
function githubFetch(source: Source): Fetcher {
  return (url, init) =>
    source.fetch(url, {
      ...init,
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
        'User-Agent': 'openrtx-web-flasher',
        ...(source.token && url.startsWith(`${API}/`) ? { Authorization: `Bearer ${source.token}` } : {}),
      },
    });
}

/** A name from GitHub as a file or folder name in the cache. */
function safe(name: string): string {
  return name.replace(/[^\w.+-]/g, '_');
}

/**
 * The bytes kept in the cache under `path` when `valid` accepts them, else those of
 * `url`, which are then kept. `what` names the download for the person.
 */
async function cached(
  source: Source,
  path: string[],
  url: string,
  valid: (bytes: Uint8Array) => boolean | Promise<boolean>,
  what: string,
): Promise<Uint8Array> {
  const kept = source.cache === null ? null : join(source.cache, 'firmware', ...path.map(safe));
  if (kept && existsSync(kept)) {
    const bytes = new Uint8Array(readFileSync(kept));
    if (await valid(bytes)) return bytes;
  }
  source.say(`Downloading ${what}`);
  let response: Response;
  try {
    response = await githubFetch(source)(url);
  } catch {
    throw new Error(`Could not download ${what}. Check your connection and try again.`);
  }
  if (!response.ok) throw new Error(`Could not download ${what} (HTTP ${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!(await valid(bytes))) throw new Error(`${what} is not the file GitHub described, so it was not used.`);
  if (kept) {
    mkdirSync(dirname(kept), { recursive: true });
    // Write beside the target and rename, so an interrupted run leaves no half file.
    writeFileSync(`${kept}.part`, bytes);
    renameSync(`${kept}.part`, kept);
  }
  return bytes;
}

/** The repository `text` names, as "owner/name". */
function repoOf(text: string | undefined): string {
  const query = parseQuery(text ?? '', '', DEFAULT_REPO);
  if (!query) throw new Error(`"${text}" is not a repository. Write it as owner/name.`);
  return query.repo;
}

/** A release as a build; its files are downloaded when they are asked for. */
function buildFromRelease(repo: string, release: ApiRelease): Build {
  return {
    id: `${repo}:${release.tag_name}`,
    kind: 'release',
    label: release.tag_name,
    date: release.published_at,
    url: release.html_url,
    files: release.assets
      .filter((asset) => isFirmware(asset.name))
      .map((asset) => ({
        name: asset.name,
        size: asset.size,
        path: asset.browser_download_url,
        // GitHub reports a digest for release files; older entries only have a size.
        sha256: asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : undefined,
      })),
  };
}

/** The releases of `repoText` that have firmware attached, newest first. */
export async function releases(repoText: string | undefined, source: Source): Promise<Build[]> {
  const repo = repoOf(repoText);
  const found = await api<ApiRelease[]>(`/repos/${repo}/releases?per_page=30`, githubFetch(source));
  return found
    .filter((release) => !release.draft)
    .map((release) => buildFromRelease(repo, release))
    .filter((build) => build.files.length > 0);
}

/** The newest CI build of the main branch of `repoText`: the development build. */
export function developmentRun(repoText: string | undefined, source: Source): Promise<CiRun> {
  return findRun({ repo: repoOf(repoText) }, githubFetch(source));
}

/** The CI build `query` asks for, with the zip that holds `radio`'s firmware. */
async function ciBuild(query: BuildQuery, radio: Radio, source: Source): Promise<Build> {
  const run = await findRun(query, githubFetch(source));
  const artifact = artifactFor(run, radio.id);
  if (!artifact) throw new Error(`The build of ${run.label} has no firmware for the ${radio.name}.`);
  if (artifact.expired) {
    throw new Error(`GitHub no longer keeps the build of ${run.label}. Run it again, or pick another.`);
  }
  const url = source.token
    ? `${API}/repos/${run.repo}/actions/artifacts/${artifact.id}/zip`
    : artifact.downloadUrl;
  const how = source.token
    ? 'from GitHub'
    : 'through nightly.link (GitHub wants a login for CI builds; set GITHUB_TOKEN to use yours)';
  const zip = await cached(
    source,
    [run.repo.replace('/', '__'), 'runs', String(run.runId), `${artifact.name}.zip`],
    url,
    isZip,
    `${artifact.name}.zip of ${run.label} ${how}`,
  );
  return buildFromRun(run, zip);
}

/**
 * The build that `what` names for `radio`: "release", a release tag, "master", a branch,
 * pull request or fork as the page's "Other" box takes them, or a file on this
 * computer (firmware, a CI zip or a backup zip).
 */
export async function resolveBuild(
  what: string,
  radio: Radio,
  repoText: string | undefined,
  source: Source,
): Promise<Build> {
  if (what === 'release') {
    const [latest] = await releases(repoText, source);
    if (!latest) throw new Error(`${repoOf(repoText)} has no release with firmware.`);
    return latest;
  }
  if (existsSync(what) && statSync(what).isFile()) {
    return buildFromLocalFile(new File([readFileSync(what)], basename(what)));
  }
  if (/\.(bin|dfu|sgl|uf2|wrap|zip)$/i.test(what) && !/^https?:/i.test(what)) {
    throw new Error(`There is no file ${what}.`);
  }
  if (/^v\d/.test(what)) {
    const repo = repoOf(repoText);
    const releasePath = `/repos/${repo}/releases/tags/${encodeURIComponent(what)}`;
    const release = await api<ApiRelease>(releasePath, githubFetch(source)).catch((e: unknown) => {
      // The API's own words are about branches and pull requests.
      throw e instanceof GithubError && e.message.includes('does not know')
        ? new Error(`${repo} has no release ${what}.`)
        : e;
    });
    return buildFromRelease(repo, release);
  }
  const query = parseQuery(repoText ?? '', what, DEFAULT_REPO);
  if (!query) throw new Error(`"${repoText}" is not a repository. Write it as owner/name.`);
  return ciBuild(query, radio, source);
}

/** The bytes of one file of `build`: in the build already, in the cache, or downloaded and checked. */
export async function fileData(build: Build, file: BuildFile, source: Source): Promise<Uint8Array> {
  if (file.data) return file.data;
  if (!file.path) throw new Error(`${file.name} has no data`);
  const [repo, tag] = build.id.split(':');
  /** True for the bytes GitHub described: by digest, else by size. */
  const valid = async (bytes: Uint8Array) =>
    file.sha256 ? (await sha256Hex(bytes)) === file.sha256 : bytes.length === file.size;
  return cached(
    source,
    [repo.replace('/', '__'), 'releases', tag, file.name],
    file.path,
    valid,
    `${file.name} of ${build.label}`,
  );
}
