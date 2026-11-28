// SPDX-License-Identifier: GPL-3.0-or-later
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  api,
  artifactFor,
  buildFromRun,
  checkZip,
  findRun,
  GithubError,
  parseQuery,
  type Artifact,
  type Fetcher,
} from './github.ts';

const REPO = 'OpenRTX/OpenRTX';

/** Fake GitHub API: maps a path prefix to a JSON body, zip bytes or a status code. */
function fakeApi(routes: Record<string, unknown>): { fetcher: Fetcher; calls: string[] } {
  const calls: string[] = [];
  // Longest prefix first, so "/repos/x/actions/runs/1/artifacts" wins over "/repos/x".
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
  const fetcher: Fetcher = async (url) => {
    const path = url.replace('https://api.github.com', '');
    calls.push(path);
    const key = keys.find((k) => path.startsWith(k));
    const body = key === undefined ? 404 : routes[key];
    if (typeof body === 'number') return new Response('{}', { status: body });
    if (body instanceof Uint8Array) return new Response(body as BodyInit);
    return new Response(JSON.stringify(body));
  };
  return { fetcher, calls };
}

const run = (id: number, sha = 'abc') => ({
  id,
  path: '.github/workflows/main.yml',
  head_sha: sha,
  head_branch: 'x',
  html_url: `https://github.com/${REPO}/actions/runs/${id}`,
  created_at: '2026-11-20T00:00:00Z',
  status: 'completed',
  conclusion: 'success',
});

describe('parseQuery', () => {
  it('reads branches, pull requests, forks and URLs', () => {
    expect(parseQuery('', '', REPO)).toEqual({ repo: REPO });
    expect(parseQuery('', 'feature/m17-fix', REPO)).toEqual({ repo: REPO, branch: 'feature/m17-fix' });
    expect(parseQuery('', '#588', REPO)).toEqual({ repo: REPO, pr: 588 });
    expect(parseQuery('', '588', REPO)).toEqual({ repo: REPO, pr: 588 });
    expect(parseQuery('turnrye/OpenRTX', 'my-branch', REPO)).toEqual({
      repo: 'turnrye/OpenRTX',
      branch: 'my-branch',
    });
    expect(parseQuery('', 'turnrye:my-branch', REPO)).toEqual({
      repo: 'turnrye/OpenRTX',
      branch: 'my-branch',
    });
    expect(parseQuery('', 'https://github.com/OpenRTX/OpenRTX/pull/588#issuecomment-1', REPO)).toEqual({
      repo: REPO,
      pr: 588,
    });
    expect(parseQuery('', 'https://github.com/turnrye/OpenRTX/tree/feat/aprs', REPO)).toEqual({
      repo: 'turnrye/OpenRTX',
      branch: 'feat/aprs',
    });
    expect(parseQuery('https://github.com/turnrye/OpenRTX/', '', REPO)).toEqual({ repo: 'turnrye/OpenRTX' });
    expect(parseQuery('not a repo', 'x', REPO)).toBeNull();
  });
});

describe('findRun', () => {
  it('looks a pull request up by its head commit and skips runs without firmware', async () => {
    const { fetcher, calls } = fakeApi({
      '/repos/OpenRTX/OpenRTX/pulls/588': { head: { sha: 'deadbeef' } },
      '/repos/OpenRTX/OpenRTX/actions/runs?head_sha=deadbeef': {
        workflow_runs: [run(2, 'deadbeef'), run(1, 'deadbeef')],
      },
      '/repos/OpenRTX/OpenRTX/actions/runs/2/artifacts': {
        artifacts: [{ id: 9, name: 'coverage-report', size_in_bytes: 1, expired: false }],
      },
      '/repos/OpenRTX/OpenRTX/actions/runs/1/artifacts': {
        artifacts: [
          { id: 10, name: 'openrtx-md3x0', size_in_bytes: 100, expired: false },
          { id: 11, name: 'release-bins', size_in_bytes: 900, expired: false },
          { id: 12, name: 'openrtx-ttwrplus', size_in_bytes: 50, expired: false },
        ],
      },
    });
    const found = await findRun({ repo: REPO, pr: 588 }, fetcher);
    expect(found.runId).toBe(1);
    expect(found.label).toBe('PR #588');
    expect(found.sha).toBe('deadbeef');
    expect(artifactFor(found, 'md3x0')?.downloadUrl).toBe(
      'https://nightly.link/OpenRTX/OpenRTX/actions/runs/1/openrtx-md3x0.zip',
    );
    expect(artifactFor(found, 'gd77')?.name).toBe('release-bins');
    expect(artifactFor(found, 'ttwrplus')?.name).toBe('openrtx-ttwrplus');
    expect(calls[0]).toBe('/repos/OpenRTX/OpenRTX/pulls/588');
  });

  it('looks only at the runs pushes started, so workflow_run runs filed under the branch cannot hide its build', async () => {
    const { fetcher, calls } = fakeApi({
      '/repos/OpenRTX/OpenRTX/actions/runs?branch=master&event=push&': { workflow_runs: [run(9)] },
      '/repos/OpenRTX/OpenRTX/actions/runs/9/artifacts': {
        artifacts: [{ id: 1, name: 'openrtx-cs7000p', size_in_bytes: 5, expired: false }],
      },
    });
    const found = await findRun({ repo: REPO, branch: 'master' }, fetcher);
    expect(found.runId).toBe(9);
    expect(calls[0]).toBe(
      '/repos/OpenRTX/OpenRTX/actions/runs?branch=master&event=push&status=completed&per_page=30',
    );
  });

  it('uses the default branch of a fork when no branch is given', async () => {
    const { fetcher } = fakeApi({
      '/repos/turnrye/OpenRTX/actions/runs?branch=main': { workflow_runs: [run(7)] },
      '/repos/turnrye/OpenRTX/actions/runs/7/artifacts': {
        artifacts: [{ id: 1, name: 'openrtx-gd77', size_in_bytes: 5, expired: false }],
      },
      '/repos/turnrye/OpenRTX': { default_branch: 'main' },
    });
    const found = await findRun({ repo: 'turnrye/OpenRTX' }, fetcher);
    expect(found.label).toBe('turnrye: main');
  });

  it('explains rate limits and missing builds', async () => {
    await expect(findRun({ repo: REPO, branch: 'x' }, fakeApi({ '/repos': 403 }).fetcher)).rejects.toThrow(
      /60 lookups/,
    );
    await expect(findRun({ repo: REPO, branch: 'x' }, fakeApi({}).fetcher)).rejects.toThrow(GithubError);
    const empty = fakeApi({ '/repos/OpenRTX/OpenRTX/actions/runs?branch=x': { workflow_runs: [] } });
    await expect(findRun({ repo: REPO, branch: 'x' }, empty.fetcher)).rejects.toThrow(/No finished builds/);
  });
});

describe('what a failed lookup says', () => {
  /** A run as the API lists it, with a status and a conclusion. */
  const listed = (id: number, status: string, conclusion: string | null) => ({
    ...run(id),
    status,
    conclusion,
  });

  it('names the repository when a pull request or the repository itself is not there', async () => {
    await expect(findRun({ repo: REPO, pr: 99999 }, fakeApi({}).fetcher)).rejects.toThrow(
      'GitHub does not know pull request #99999 in OpenRTX/OpenRTX.',
    );
    await expect(findRun({ repo: 'nobody/nothing' }, fakeApi({}).fetcher)).rejects.toThrow(
      'GitHub does not know the repository nobody/nothing.',
    );
    await expect(findRun({ repo: 'nobody/nothing', branch: 'x' }, fakeApi({}).fetcher)).rejects.toThrow(
      'GitHub does not know the repository nobody/nothing.',
    );
  });

  it('tells a build that is still running from one that failed and from none at all', async () => {
    const runs = '/repos/OpenRTX/OpenRTX/actions/runs?branch=x&event=push';
    const running = fakeApi({
      [`${runs}&status=completed`]: { workflow_runs: [] },
      [`${runs}&per_page=5`]: { workflow_runs: [listed(4, 'in_progress', null)] },
    });
    await expect(findRun({ repo: REPO, branch: 'x' }, running.fetcher)).rejects.toThrow(
      'The build for x in OpenRTX/OpenRTX is still running. Try again when it has finished: ' +
        'https://github.com/OpenRTX/OpenRTX/actions/runs/4',
    );
    // The reason costs one more request, and only after the lookup came up empty.
    expect(running.calls).toHaveLength(2);

    const failedRun = listed(5, 'completed', 'failure');
    const failed = fakeApi({
      [runs]: { workflow_runs: [failedRun] },
      '/repos/OpenRTX/OpenRTX/actions/runs/5/artifacts': { artifacts: [] },
    });
    await expect(findRun({ repo: REPO, branch: 'x' }, failed.fetcher)).rejects.toThrow(
      /The newest build for x in OpenRTX\/OpenRTX did not succeed \(failure\).*actions\/runs\/5$/,
    );

    const noFirmware = fakeApi({
      [runs]: { workflow_runs: [run(6)] },
      '/repos/OpenRTX/OpenRTX/actions/runs/6/artifacts': {
        artifacts: [{ id: 1, name: 'coverage-report', size_in_bytes: 1, expired: false }],
      },
    });
    await expect(findRun({ repo: REPO, branch: 'x' }, noFirmware.fetcher)).rejects.toThrow(
      'The finished builds for x in OpenRTX/OpenRTX have no firmware files.',
    );

    const none = fakeApi({ [runs]: { workflow_runs: [] } });
    await expect(findRun({ repo: REPO, branch: 'x' }, none.fetcher)).rejects.toThrow(
      /^No finished builds found for x\. Looked in OpenRTX\/OpenRTX: check the name/,
    );
  });

  it('says when the hourly limit starts again, and does not blame the limit for another refusal', async () => {
    const refusal =
      (headers: Record<string, string>): Fetcher =>
      async () =>
        new Response('{}', { status: 403, headers });
    const reset = Math.floor(Date.UTC(2026, 10, 27, 14, 32) / 1000);
    const at = new Date(reset * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    await expect(
      api('/x', refusal({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) })),
    ).rejects.toThrow(
      `GitHub allows 60 lookups an hour from one address and they are used up. They come back at ${at}.`,
    );
    await expect(api('/x', refusal({}))).rejects.toThrow(/they are used up\. Try again later\.$/);
    await expect(api('/x', refusal({ 'x-ratelimit-remaining': '41' }))).rejects.toThrow(
      'GitHub refused the lookup (HTTP 403).',
    );
  });
});

describe('checkZip', () => {
  /** An artifact with the digest GitHub would list for `zip`, or with none. */
  const artifact = async (zip?: Uint8Array): Promise<Artifact> => {
    const digest = zip && new Uint8Array(await crypto.subtle.digest('SHA-256', zip as BufferSource));
    return {
      id: 1,
      name: 'openrtx-md3x0',
      size: 3,
      expired: false,
      downloadUrl: 'https://nightly.link/x.zip',
      sha256: digest && Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join(''),
    };
  };

  it('takes the zip GitHub lists, refuses another, and says when there is nothing to compare with', async () => {
    const right = zipSync({ 'openrtx_md3x0_fix.bin': new Uint8Array([1, 2, 3]) });
    const other = zipSync({ 'openrtx_md3x0_fix.bin': new Uint8Array([1, 2, 4]) });
    expect(await checkZip(await artifact(right), right)).toBe('match');
    expect(await checkZip(await artifact(right), other)).toBe('mismatch');
    expect(await checkZip(await artifact(), other)).toBe('unknown');
  });

  it('reads the digest of each artifact from the API, in either case, and ignores other kinds', async () => {
    const { fetcher } = fakeApi({
      '/repos/OpenRTX/OpenRTX/actions/runs?branch=master': { workflow_runs: [run(9)] },
      '/repos/OpenRTX/OpenRTX/actions/runs/9/artifacts': {
        artifacts: [
          {
            id: 1,
            name: 'openrtx-md3x0',
            size_in_bytes: 5,
            expired: false,
            digest: `sha256:${'AB'.repeat(32)}`,
          },
          { id: 2, name: 'openrtx-gd77', size_in_bytes: 5, expired: false, digest: null },
          { id: 3, name: 'openrtx-mod17', size_in_bytes: 5, expired: false, digest: 'md5:abcdef' },
          { id: 4, name: 'openrtx-dm1701', size_in_bytes: 5, expired: false },
        ],
      },
    });
    const found = await findRun({ repo: REPO, branch: 'master' }, fetcher);
    expect(artifactFor(found, 'md3x0')?.sha256).toBe('ab'.repeat(32));
    expect(artifactFor(found, 'gd77')?.sha256).toBeUndefined();
    expect(artifactFor(found, 'mod17')?.sha256).toBeUndefined();
    expect(artifactFor(found, 'dm1701')?.sha256).toBeUndefined();
  });
});

describe('buildFromRun', () => {
  it('unpacks the zip the user dropped into build files', () => {
    const zip = zipSync({ 'openrtx_md3x0_fix.bin': new Uint8Array([1, 2, 3]) });
    const ci = { repo: REPO, runId: 1, label: 'PR #588', sha: 'abc', date: 'd', url: 'u', artifacts: [] };
    const build = buildFromRun(ci, zip);
    expect(build.files.map((f) => [f.name, f.size])).toEqual([['openrtx_md3x0_fix.bin', 3]]);
    expect(build.id).toBe('ci:OpenRTX/OpenRTX:1');
  });
});
