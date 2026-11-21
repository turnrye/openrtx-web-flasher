// SPDX-License-Identifier: GPL-3.0-or-later
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { artifactFor, buildFromRun, findRun, GithubError, parseQuery, type Fetcher } from './github.ts';

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

describe('buildFromRun', () => {
  it('unpacks the zip the user dropped into build files', () => {
    const zip = zipSync({ 'openrtx_md3x0_fix.bin': new Uint8Array([1, 2, 3]) });
    const ci = { repo: REPO, runId: 1, label: 'PR #588', sha: 'abc', date: 'd', url: 'u', artifacts: [] };
    const build = buildFromRun(ci, zip);
    expect(build.files.map((f) => [f.name, f.size])).toEqual([['openrtx_md3x0_fix.bin', 3]]);
    expect(build.id).toBe('ci:OpenRTX/OpenRTX:1');
  });
});
