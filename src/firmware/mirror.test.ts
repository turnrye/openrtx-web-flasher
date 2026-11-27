// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * scripts/mirror-firmware.mjs, which writes the firmware/manifest.json this folder reads,
 * run as the build runs it: against a stand-in for GitHub's API on this computer, with
 * the build's zip already in the cache, so nothing is fetched from the network.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Manifest } from './builds.ts';

const SCRIPT = fileURLToPath(new URL('../../scripts/mirror-firmware.mjs', import.meta.url));
const APP = new Uint8Array(1000).fill(1);
const DSP = new Uint8Array(500).fill(2);

/** One successful CI run of the main branch, as GitHub's API lists it. */
const RUN = {
  id: 123,
  name: 'Build',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  head_branch: 'master',
  head_sha: 'a'.repeat(40),
  created_at: '2026-11-27T00:00:00Z',
  html_url: 'https://example.invalid/run/123',
};

let dir: string;
let server: Server;
/** When true, the stand-in no longer knows the repository's CI runs. */
let runsGone = false;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ortx-mirror-test-'));
  // The C62's CI artifact holds files that are mirrored in a folder of their own.
  const runDir = join(dir, 'cache', 'firmware', 'fake__repo', 'runs', '123');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'openrtx-c62.zip'), zipSync({ 'zephyr.bin': APP, 'dsp_firmware.bin': DSP }));
  server = createServer((request, response) => {
    const url = request.url ?? '';
    /** Answers with `body` as JSON. */
    const send = (body: unknown) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(body));
    };
    if (url.startsWith('/repos/fake/repo/releases')) return send([]);
    if (url.startsWith('/repos/fake/repo/actions/runs') && !runsGone) {
      return url.includes('/artifacts')
        ? send({ artifacts: [{ id: 1, name: 'openrtx-c62', expired: false, size_in_bytes: 1 }] })
        : send({ total_count: 1, workflow_runs: [RUN] });
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Runs the mirror into `out`; resolves with its exit code and what it printed. */
function mirror(out: string): Promise<{ code: number; output: string }> {
  const env = {
    ...process.env,
    ORTX_REPO: 'fake/repo',
    ORTX_CACHE: join(dir, 'cache'),
    ORTX_GITHUB_API: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    ORTX_BRANCH: 'master',
    GITHUB_TOKEN: '',
  };
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, '--out', out], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code ?? 1) : 0, output: stdout + stderr });
    });
  });
}

/** The names of the files of every build in the manifest the mirror wrote into `out`. */
function mirrored(out: string): string[] {
  const manifest = JSON.parse(readFileSync(join(out, 'firmware', 'manifest.json'), 'utf8')) as Manifest;
  return manifest.builds.flatMap((build) => build.files.map((file) => `${build.id}/${file.name}`));
}

describe('the firmware mirror', () => {
  it('keeps a build with files in a folder as the copy to fall back on', async () => {
    const first = join(dir, 'one');
    const fresh = await mirror(first);
    expect(fresh.output).not.toContain('ENOENT');
    expect(fresh.code).toBe(0);
    expect(mirrored(first)).toEqual(['master/c62/zephyr.bin', 'master/c62/dsp_firmware.bin']);
    const kept = join(dir, 'cache', 'firmware', 'fake__repo', 'last');
    expect(Buffer.compare(readFileSync(join(kept, 'master', 'c62', 'zephyr.bin')), APP)).toBe(0);
    expect(existsSync(join(kept, '..', 'last-manifest.json'))).toBe(true);

    // GitHub no longer answers for the build: the copy from the last mirror is published.
    runsGone = true;
    const second = join(dir, 'two');
    const fallback = await mirror(second);
    expect(fallback.code).toBe(0);
    expect(fallback.output).toContain('WARNING: using the copy mirrored on');
    expect(mirrored(second)).toEqual(mirrored(first));
    expect(
      Buffer.compare(readFileSync(join(second, 'firmware', 'master', 'c62', 'dsp_firmware.bin')), DSP),
    ).toBe(0);
  }, 60_000);
});
