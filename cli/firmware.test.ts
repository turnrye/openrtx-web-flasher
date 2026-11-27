// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { afterAll, describe, expect, it } from 'vitest';
import { companionsFor, fileForRadio } from '../src/firmware/builds.ts';
import { radioById } from '../src/radios.ts';
import { developmentRun, fileData, releases, resolveBuild, type Source } from './firmware.ts';
import { folder, removeFolders } from './test-support.ts';

const REPO = 'OpenRTX/OpenRTX';
const mod17 = radioById('mod17')!;
const c62 = radioById('c62')!;

/** SHA-256 of `bytes` as hex. */
function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** One request the fake GitHub saw. */
interface Call {
  url: string;
  authorization?: string;
}

/**
 * A fake GitHub, nightly.link and release download host: maps an address prefix to a JSON
 * body, bytes or a status code, and records every request with its login.
 */
function fakeWeb(routes: Record<string, unknown>, extra: Partial<Source> = {}) {
  const calls: Call[] = [];
  const said: string[] = [];
  // Longest prefix first, so a run's artifacts win over the run list.
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
  const source: Source = {
    cache: null,
    say: (line) => void said.push(line),
    fetch: (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, authorization: headers.Authorization });
      const key = keys.find((k) => url.startsWith(k));
      const body = key === undefined ? 404 : routes[key];
      if (typeof body === 'number') return Promise.resolve(new Response('{}', { status: body }));
      if (body instanceof Uint8Array) return Promise.resolve(new Response(body as BodyInit));
      return Promise.resolve(new Response(JSON.stringify(body)));
    },
    ...extra,
  };
  return { source, calls, said };
}

const firmware = new Uint8Array(randomBytes(2000));

/** A release as the API lists it, with one Module 17 file and the emulator. */
function release(tag: string, digest: string | null = `sha256:${sha256(firmware)}`) {
  return {
    tag_name: tag,
    draft: false,
    published_at: '2026-10-04T08:23:00Z',
    html_url: `https://github.com/${REPO}/releases/tag/${tag}`,
    assets: [
      {
        name: `openrtx_mod17_${tag}.bin`,
        size: firmware.length,
        browser_download_url: `https://github.com/${REPO}/releases/download/${tag}/openrtx_mod17_${tag}.bin`,
        digest,
      },
      { name: `openrtx_linux_${tag}`, size: 5, browser_download_url: 'https://example.invalid/x' },
    ],
  };
}

const API = 'https://api.github.com';
const RUN = {
  id: 77,
  path: '.github/workflows/main.yml',
  head_sha: 'abcdef0123456789',
  head_branch: 'x',
  html_url: `https://github.com/${REPO}/actions/runs/77`,
  created_at: '2026-11-20T00:00:00Z',
  status: 'completed',
  conclusion: 'success',
};
const ZIP = zipSync({ 'zephyr.bin': firmware, 'dsp_firmware.bin': new Uint8Array(randomBytes(500)) });

/** Routes of a repository with one finished run that built the C62 and the Module 17. */
function ciRoutes(expired = false): Record<string, unknown> {
  return {
    [`${API}/repos/${REPO}/pulls/588`]: { head: { sha: RUN.head_sha } },
    [`${API}/repos/${REPO}/actions/runs?`]: { workflow_runs: [RUN] },
    [`${API}/repos/${REPO}/actions/runs/77/artifacts`]: {
      artifacts: [
        { id: 901, name: 'openrtx-c62', size_in_bytes: ZIP.length, expired },
        { id: 902, name: 'unit-test-logs', size_in_bytes: 1, expired: false },
      ],
    },
    [`${API}/repos/${REPO}/actions/artifacts/901/zip`]: ZIP,
    [`https://nightly.link/${REPO}/actions/runs/77/openrtx-c62.zip`]: ZIP,
    [`${API}/repos/${REPO}`]: { default_branch: 'master' },
  };
}

afterAll(removeFolders);

describe('firmware for the command line', () => {
  it('takes the newest release that has firmware as "release", and downloads only the file asked for', async () => {
    const { source, calls, said } = fakeWeb({
      [`${API}/repos/${REPO}/releases?`]: [
        { ...release('v0.5.0-draft'), draft: true },
        { ...release('v0.4.6'), assets: [] },
        release('v0.4.5'),
        release('v0.4.4'),
      ],
      [`https://github.com/${REPO}/releases/download/v0.4.5/`]: firmware,
    });
    const build = await resolveBuild('release', mod17, undefined, source);
    expect(build).toMatchObject({ kind: 'release', label: 'v0.4.5' });
    // The emulator is not firmware for a radio.
    expect(build.files.map((f) => f.name)).toEqual(['openrtx_mod17_v0.4.5.bin']);
    expect(calls.length).toBe(1);

    const data = await fileData(build, fileForRadio(mod17, build)!, source);
    expect(Buffer.compare(data, firmware)).toBe(0);
    expect(said).toEqual(['Downloading openrtx_mod17_v0.4.5.bin of v0.4.5']);
    expect((await releases(undefined, source)).map((b) => b.label)).toEqual(['v0.4.5', 'v0.4.4']);
  });

  it('keeps the second image a radio needs from a release, though it is not named openrtx_', async () => {
    const tag = 'v9.9.9';
    const dsp = new Uint8Array(randomBytes(300));
    const base = `https://github.com/${REPO}/releases/download/${tag}`;
    const withCompanion = {
      ...release(tag),
      assets: [
        {
          name: `openrtx_c62_${tag}.bin`,
          size: firmware.length,
          browser_download_url: `${base}/openrtx_c62_${tag}.bin`,
        },
        { name: 'dsp_firmware.bin', size: dsp.length, browser_download_url: `${base}/dsp_firmware.bin` },
        { name: 'notes.txt', size: 5, browser_download_url: `${base}/notes.txt` },
        { name: `openrtx_linux_${tag}`, size: 5, browser_download_url: `${base}/openrtx_linux_${tag}` },
      ],
    };
    const { source } = fakeWeb({
      [`${API}/repos/${REPO}/releases?`]: [withCompanion],
      [`${base}/dsp_firmware.bin`]: dsp,
    });
    const build = await resolveBuild('release', c62, undefined, source);
    expect(build.files.map((f) => f.name)).toEqual([`openrtx_c62_${tag}.bin`, 'dsp_firmware.bin']);
    // It is found as the C62's DSP image, and its bytes can be had.
    const [companion] = companionsFor(c62, build);
    expect(companion.found?.name).toBe('dsp_firmware.bin');
    expect(Buffer.compare(await fileData(build, companion.found!, source), dsp)).toBe(0);
  });

  it('refuses a release file that is not the one GitHub described', async () => {
    const routes = {
      [`${API}/repos/${REPO}/releases/tags/v0.4.5`]: release('v0.4.5'),
      [`https://github.com/${REPO}/releases/download/`]: new Uint8Array(randomBytes(2000)),
    };
    const { source } = fakeWeb(routes);
    const build = await resolveBuild('v0.4.5', mod17, undefined, source);
    await expect(fileData(build, build.files[0], source)).rejects.toThrow('not the file GitHub described');

    // Older releases carry no digest; the size is then all there is to check.
    const old = fakeWeb({
      ...routes,
      [`${API}/repos/${REPO}/releases/tags/v0.4.5`]: release('v0.4.5', null),
    });
    const sized = await resolveBuild('v0.4.5', mod17, undefined, old.source);
    expect((await fileData(sized, sized.files[0], old.source)).length).toBe(2000);
  });

  it('finds a past release by its tag, in the repository named', async () => {
    const { source, calls } = fakeWeb({
      [`${API}/repos/someone/OpenRTX/releases/tags/v0.3.1`]: release('v0.3.1'),
    });
    const build = await resolveBuild('v0.3.1', mod17, 'https://github.com/someone/OpenRTX', source);
    expect(build.label).toBe('v0.3.1');
    expect(calls[0].url).toBe(`${API}/repos/someone/OpenRTX/releases/tags/v0.3.1`);
    await expect(resolveBuild('v9.9.9', mod17, undefined, source)).rejects.toThrow(
      'OpenRTX/OpenRTX has no release v9.9.9.',
    );
    await expect(resolveBuild('v0.3.1', mod17, 'not a repo', source)).rejects.toThrow('is not a repository');
  });

  it('downloads a pull request’s CI build through nightly.link when there is no login', async () => {
    const { source, calls, said } = fakeWeb(ciRoutes());
    const build = await resolveBuild('588', c62, undefined, source);
    expect(build).toMatchObject({ kind: 'ci', label: 'PR #588', sha: RUN.head_sha });
    expect(build.files.map((f) => f.name).sort()).toEqual(['dsp_firmware.bin', 'zephyr.bin']);
    expect(calls.at(-1)!.url).toBe(`https://nightly.link/${REPO}/actions/runs/77/openrtx-c62.zip`);
    expect(calls.every((call) => call.authorization === undefined)).toBe(true);
    expect(said[0]).toContain('through nightly.link');
    expect(said[0]).toContain('GITHUB_TOKEN');
  });

  it('downloads it from GitHub with a login, and shows the token to GitHub’s API only', async () => {
    const { source, calls, said } = fakeWeb(ciRoutes(), { token: 'secret-token' });
    const build = await resolveBuild('#588', c62, undefined, source);
    expect(fileForRadio(c62, build)!.name).toBe('zephyr.bin');
    expect(calls.at(-1)).toEqual({
      url: `${API}/repos/${REPO}/actions/artifacts/901/zip`,
      authorization: 'Bearer secret-token',
    });
    expect(said[0]).toBe('Downloading openrtx-c62.zip of PR #588 from GitHub');

    // A release file is not on the API: no token goes with it.
    const web = fakeWeb(
      {
        [`${API}/repos/${REPO}/releases/tags/v0.4.5`]: release('v0.4.5'),
        [`https://github.com/${REPO}/releases/download/`]: firmware,
      },
      { token: 'secret-token' },
    );
    const released = await resolveBuild('v0.4.5', mod17, undefined, web.source);
    await fileData(released, released.files[0], web.source);
    expect(web.calls.map((call) => call.authorization)).toEqual(['Bearer secret-token', undefined]);
  });

  it('finds branches and forks the way the page’s "Other" box does', async () => {
    const { source, calls } = fakeWeb(ciRoutes());
    expect((await resolveBuild('master', c62, undefined, source)).label).toBe('master');
    expect(calls[0].url).toContain('/actions/runs?branch=master&');

    const fork = fakeWeb({
      'https://api.github.com/repos/someone/OpenRTX/actions/runs?': { workflow_runs: [] },
    });
    await expect(resolveBuild('someone:feat/x', c62, undefined, fork.source)).rejects.toThrow(
      'No finished builds found for feat/x.',
    );
    expect(fork.calls[0].url).toBe(
      `${API}/repos/someone/OpenRTX/actions/runs?branch=feat%2Fx&event=push&status=completed&per_page=30`,
    );
    expect((await developmentRun(undefined, source)).sha).toBe(RUN.head_sha);
  });

  it('says so when the build has nothing for the radio, or GitHub threw it away', async () => {
    const { source } = fakeWeb(ciRoutes());
    await expect(resolveBuild('588', radioById('ttwrplus')!, undefined, source)).rejects.toThrow(
      'The build of PR #588 has no firmware for the Lilygo T-TWR Plus.',
    );
    const gone = fakeWeb(ciRoutes(true));
    await expect(resolveBuild('588', c62, undefined, gone.source)).rejects.toThrow('no longer keeps');
  });

  it('keeps downloads in the cache, in the layout the firmware mirror uses, and reuses them', async () => {
    const cache = folder();
    const { source, calls } = fakeWeb(
      {
        ...ciRoutes(),
        [`${API}/repos/${REPO}/releases/tags/v0.4.5`]: release('v0.4.5'),
        [`https://github.com/${REPO}/releases/download/`]: firmware,
      },
      { cache },
    );
    const released = await resolveBuild('v0.4.5', mod17, undefined, source);
    await fileData(released, released.files[0], source);
    await resolveBuild('588', c62, undefined, source);
    const kept = join(cache, 'firmware', 'OpenRTX__OpenRTX');
    expect(existsSync(join(kept, 'releases', 'v0.4.5', 'openrtx_mod17_v0.4.5.bin'))).toBe(true);
    expect(Buffer.compare(readFileSync(join(kept, 'runs', '77', 'openrtx-c62.zip')), ZIP)).toBe(0);

    const before = calls.length;
    await fileData(released, released.files[0], source);
    await resolveBuild('588', c62, undefined, source);
    const again = calls.slice(before).map((call) => call.url);
    expect(again.some((url) => url.includes('/releases/download/') || url.includes('nightly.link'))).toBe(
      false,
    );

    // A cached file that no longer matches is downloaded again, not trusted.
    writeFileSync(join(kept, 'releases', 'v0.4.5', 'openrtx_mod17_v0.4.5.bin'), 'damaged');
    expect(Buffer.compare(await fileData(released, released.files[0], source), firmware)).toBe(0);
  });

  it('uses a download that arrived and checked out even when the cache cannot keep it', async () => {
    // Where the cache should be there is a file: nothing can be written under it, by anyone.
    const blocked = join(folder(), 'taken');
    writeFileSync(blocked, 'not a folder');
    const routes = {
      [`${API}/repos/${REPO}/releases?`]: [release('v0.4.5')],
      [`https://github.com/${REPO}/releases/download/v0.4.5/`]: firmware,
      ...ciRoutes(),
    };
    const { source, said } = fakeWeb(routes, { cache: join(blocked, 'cache') });
    const build = await resolveBuild('release', mod17, undefined, source);
    const data = await fileData(build, fileForRadio(mod17, build)!, source);
    expect(Buffer.compare(data, firmware)).toBe(0);
    expect(said).toHaveLength(2);
    expect(said[1]).toMatch(
      /^The download could not be kept in the cache \(.*taken.*\); it is used all the same\.$/,
    );

    // A CI zip goes the same way.
    const ci = await resolveBuild('588', c62, undefined, source);
    expect(fileForRadio(c62, ci)!.name).toBe('zephyr.bin');
  });

  it('takes a file on this computer: firmware, or a CI zip', async () => {
    const dir = folder();
    const { source, calls } = fakeWeb({});
    writeFileSync(join(dir, 'openrtx_mod17_test.bin'), firmware);
    const single = await resolveBuild(join(dir, 'openrtx_mod17_test.bin'), mod17, undefined, source);
    expect(single).toMatchObject({ kind: 'local', label: 'openrtx_mod17_test.bin' });
    expect(Buffer.compare(await fileData(single, fileForRadio(mod17, single)!, source), firmware)).toBe(0);

    writeFileSync(join(dir, 'build.zip'), ZIP);
    const zipped = await resolveBuild(join(dir, 'build.zip'), c62, undefined, source);
    expect(fileForRadio(c62, zipped)!.name).toBe('zephyr.bin');
    // Nothing was asked of the network for a file.
    expect(calls).toEqual([]);
    await expect(resolveBuild(join(dir, 'missing.bin'), mod17, undefined, source)).rejects.toThrow(
      'There is no file',
    );
  });

  it('passes on what GitHub says when it is out of lookups or unreachable', async () => {
    const limited = fakeWeb({ [`${API}/repos/${REPO}/releases?`]: 403 });
    await expect(resolveBuild('release', mod17, undefined, limited.source)).rejects.toThrow(
      'GitHub allows 60 lookups an hour',
    );
    const down: Source = { ...limited.source, fetch: () => Promise.reject(new Error('offline')) };
    await expect(resolveBuild('release', mod17, undefined, down)).rejects.toThrow('Could not reach GitHub');
  });
});
