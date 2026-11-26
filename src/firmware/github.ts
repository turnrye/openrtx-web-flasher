// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Finds CI builds of a branch, pull request or fork through the GitHub API.
 *
 * Listing runs and artifacts works from a web page without logging in (60 requests an
 * hour per address). Downloading an artifact does not: the API wants a login, and
 * nightly.link, which serves the same zips without one, does not send the header that
 * lets a page read them. So the page hands the user the nightly.link address and takes
 * the zip back by drag and drop.
 */
import { filesFromZip, type Build } from './builds.ts';

const API = 'https://api.github.com';

/** What the user typed: a repository and a branch, or a pull request number. */
export interface BuildQuery {
  /** "owner/repo". */
  repo: string;
  /** Branch name. */
  branch?: string;
  /** Pull request number in `repo`. */
  pr?: number;
}

/** One zip a workflow run uploaded. */
export interface Artifact {
  id: number;
  name: string;
  size: number;
  expired: boolean;
  /** nightly.link address: downloads without a GitHub login, but only by a click. */
  downloadUrl: string;
}

/** A workflow run and the firmware zips it produced. */
export interface CiRun {
  repo: string;
  runId: number;
  label: string;
  sha: string;
  date: string;
  url: string;
  artifacts: Artifact[];
}

/** Error whose message can be shown to the user as-is. */
export class GithubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GithubError';
  }
}

/** Fetch used for API calls; replaceable in tests. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Parses what the user typed into a query. `ref` may be a branch name, a pull request
 * ("588" or "#588"), a fork branch as GitHub shows it ("owner:branch"), or a github.com
 * pull request or branch URL, which then also decides the repository. An empty `ref`
 * means the repository's default branch.
 */
export function parseQuery(repoText: string, ref: string, defaultRepo: string): BuildQuery | null {
  const input = ref.trim();
  const typedRepo = repoText
    .trim()
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/(\.git)?\/?$/, '');
  const repo = typedRepo || defaultRepo;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  const url = /^https?:\/\/github\.com\/([^/\s]+\/[^/\s#]+)(?:\/(pull|tree)\/([^\s?#]+))?/.exec(input);
  if (url) {
    const urlRepo = url[1].replace(/\.git$/, '');
    if (url[2] === 'pull') return { repo: urlRepo, pr: Number(url[3].split('/')[0]) };
    if (url[2] === 'tree') return { repo: urlRepo, branch: decodeURIComponent(url[3]) };
    return { repo: urlRepo };
  }
  if (!input) return { repo };
  const pr = /^#?(\d+)$/.exec(input);
  if (pr) return { repo, pr: Number(pr[1]) };
  const forkBranch = /^([\w.-]+):(.+)$/.exec(input);
  if (forkBranch) return { repo: `${forkBranch[1]}/${repo.split('/')[1]}`, branch: forkBranch[2] };
  return { repo, branch: input };
}

/** Calls the GitHub API and returns the JSON body, with errors a person can act on. */
export async function api<T>(path: string, fetcher: Fetcher): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  let response: Response;
  try {
    response = await fetcher(`${API}${path}`, { headers });
  } catch {
    throw new GithubError('Could not reach GitHub. Check your connection and try again.');
  }
  if (response.status === 404)
    throw new GithubError('GitHub does not know that repository, branch or pull request.');
  if (response.status === 403 || response.status === 429) {
    throw new GithubError(
      'GitHub allows 60 lookups an hour from one address and they are used up. Try again later.',
    );
  }
  if (!response.ok) throw new GithubError(`GitHub answered with an error (HTTP ${response.status}).`);
  return (await response.json()) as T;
}

interface ApiRun {
  id: number;
  path: string;
  head_sha: string;
  head_branch: string | null;
  html_url: string;
  created_at: string;
  status: string;
  conclusion: string | null;
}

interface ApiArtifact {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
}

/**
 * Finds the newest finished run for the query that uploaded firmware. Runs of pull
 * requests from forks live in the repository the request targets, so they are looked up
 * by commit rather than by branch. A branch's builds are the runs its pushes started:
 * GitHub also files every workflow_run run (such as OpenRTX's "PR build comment", one
 * for each pull request build) under the default branch, and on a busy day those fill
 * the newest runs and hide the build.
 */
export async function findRun(query: BuildQuery, fetcher: Fetcher = fetch): Promise<CiRun> {
  const repo = query.repo;
  let label: string;
  let filter: string;
  if (query.pr !== undefined) {
    const pull = await api<{ head: { sha: string } }>(`/repos/${repo}/pulls/${query.pr}`, fetcher);
    filter = `head_sha=${pull.head.sha}`;
    label = `PR #${query.pr}`;
  } else {
    const branch =
      query.branch ?? (await api<{ default_branch: string }>(`/repos/${repo}`, fetcher)).default_branch;
    filter = `branch=${encodeURIComponent(branch)}&event=push`;
    label = branch;
  }
  const { workflow_runs: runs } = await api<{ workflow_runs: ApiRun[] }>(
    `/repos/${repo}/actions/runs?${filter}&status=completed&per_page=30`,
    fetcher,
  );
  // Newest first. A run counts when it uploaded at least one firmware zip, whatever the
  // workflow file is called, so forks with renamed workflows still work.
  for (const run of runs.slice(0, 8)) {
    const { artifacts } = await api<{ artifacts: ApiArtifact[] }>(
      `/repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`,
      fetcher,
    );
    const firmware = artifacts.filter((a) => /^(openrtx-|release-bins$|zephyr-release-bins$)/.test(a.name));
    if (firmware.length === 0) continue;
    return {
      repo,
      runId: run.id,
      label: repo === 'OpenRTX/OpenRTX' ? label : `${repo.split('/')[0]}: ${label}`,
      sha: run.head_sha,
      date: run.created_at,
      url: run.html_url,
      artifacts: firmware.map((a) => ({
        id: a.id,
        name: a.name,
        size: a.size_in_bytes,
        expired: a.expired,
        downloadUrl: `https://nightly.link/${repo}/actions/runs/${run.id}/${a.name}.zip`,
      })),
    };
  }
  throw new GithubError(
    runs.length === 0
      ? `No finished builds found for ${label}. Has the build run yet?`
      : `The builds for ${label} have no firmware files. They may still be running or have failed.`,
  );
}

/** The artifact that holds `radioId`'s firmware: its own zip, else the all-radios zip. */
export function artifactFor(run: CiRun, radioId: string): Artifact | undefined {
  return (
    run.artifacts.find((a) => a.name === `openrtx-${radioId}`) ??
    run.artifacts.find((a) => a.name === (radioId === 'ttwrplus' ? 'zephyr-release-bins' : 'release-bins'))
  );
}

/** Makes a build out of a run and the bytes of one of its artifact zips. */
export function buildFromRun(run: CiRun, zip: Uint8Array): Build {
  return {
    id: `ci:${run.repo}:${run.runId}`,
    kind: 'ci',
    label: run.label,
    date: run.date,
    sha: run.sha,
    url: run.url,
    files: filesFromZip(zip),
  };
}
