#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Copies OpenRTX firmware next to the site so the page can load it from its own origin.
 *
 * Browsers will not let a page read GitHub release files or nightly.link zips, so this
 * runs at build time, where that restriction does not exist. It writes
 * <out>/firmware/<build>/<file> and <out>/firmware/manifest.json.
 *
 *   node scripts/mirror-firmware.mjs [--out public] [--strict]
 *
 * Environment:
 *   ORTX_REPO        repository to mirror (default OpenRTX/OpenRTX)
 *   ORTX_RELEASES    how many releases to keep, newest first (default 6)
 *   ORTX_BRANCH      branch whose latest CI build is mirrored (default master)
 *   GITHUB_TOKEN     optional; raises the API rate limit from 60 requests an hour
 *   ORTX_GITHUB_API  API address, for testing the fall-back (default https://api.github.com)
 *
 * Every file it downloads is kept in the per-user cache (scripts/cache.mjs). A release
 * file never changes, so it is downloaded once; a CI build is downloaded once per run.
 * Which builds exist still has to be asked of GitHub each time. When that fails, after
 * retries, the builds from the last successful mirror are used instead and a warning
 * says so: a GitHub outage makes the bundled firmware a little old, it does not break
 * the build. --strict only fails when there is no such copy to fall back on.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { unzipSync } from 'fflate';
import { cacheDir, download } from './cache.mjs';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const outArg = args.indexOf('--out');
const outDir = join(outArg >= 0 ? args[outArg + 1] : 'public', 'firmware');
const repo = process.env.ORTX_REPO || 'OpenRTX/OpenRTX';
const keepReleases = Number(process.env.ORTX_RELEASES || 6);
const branch = process.env.ORTX_BRANCH || 'master';
const token = process.env.GITHUB_TOKEN || '';
const cache = join(cacheDir(), 'firmware', repo.replace('/', '__'));
const lastPath = join(cache, 'last-manifest.json');
const AGENT = { 'User-Agent': 'openrtx-web-flasher' };
// Overridable so the fall-back can be tried without waiting for GitHub to break.
const apiBase = process.env.ORTX_GITHUB_API || 'https://api.github.com';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** Firmware files worth mirroring: everything OpenRTX names openrtx_<target>…, minus the emulator. */
const isFirmware = (name) => /^openrtx_[a-z0-9]+[_.]/i.test(name) && !/^openrtx_linux/i.test(name);

/**
 * The name a file of the CI artifact `artifact` is mirrored under, or null to leave it
 * out. A file OpenRTX named openrtx_<target>… keeps its name. Anything else in the
 * artifact of one radio (the C62's zephyr.bin and dsp_firmware.bin) goes in a folder
 * named after that radio, so two radios' zephyr.bin are never taken for each other; the
 * page looks there (src/radios.ts, src/firmware/builds.ts).
 */
function mirroredName(artifact, base) {
  if (isFirmware(base)) return base;
  const target = /^openrtx-([a-z0-9]+)$/i.exec(artifact)?.[1];
  return target && target !== 'linux' && !/^openrtx_/i.test(base) ? `${target}/${base}` : null;
}

/** Calls the GitHub API and returns JSON. */
async function api(path) {
  const headers = { Accept: 'application/vnd.github+json', ...AGENT };
  if (token) headers.Authorization = `Bearer ${token}`;
  return JSON.parse(new TextDecoder().decode(await download(`${apiBase}${path}`, headers)));
}

/** Writes `bytes` to `path` in one step, so an interrupted run leaves no half file. */
function save(path, bytes) {
  writeFileSync(`${path}.part`, bytes);
  renameSync(`${path}.part`, path);
}

/**
 * Returns the bytes cached at `path` when `valid` accepts them, else downloads `url`,
 * caches the result and returns it.
 */
async function cached(path, url, valid) {
  if (existsSync(path)) {
    const bytes = readFileSync(path);
    if (valid(bytes)) return bytes;
  }
  const bytes = await download(url, AGENT);
  if (!valid(bytes)) throw new Error(`${url} is not the file GitHub described`);
  mkdirSync(join(path, '..'), { recursive: true });
  save(path, bytes);
  return bytes;
}

/** Copies one firmware file into the site and returns its manifest entry. */
function publish(buildId, name, data) {
  const path = join(outDir, buildId, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  return { name, size: data.length, path: `firmware/${buildId}/${name}`, sha256: sha256(data) };
}

/** Mirrors the newest releases that have firmware attached. */
async function mirrorReleases() {
  const releases = await api(`/repos/${repo}/releases?per_page=30`);
  const builds = [];
  for (const release of releases) {
    if (builds.length >= keepReleases) break;
    if (release.draft) continue;
    const assets = release.assets.filter((a) => isFirmware(a.name));
    if (assets.length === 0) continue;
    const files = [];
    for (const asset of assets) {
      // GitHub reports a digest for release files; older entries only have a size.
      const digest = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : null;
      const valid = (bytes) => (digest ? sha256(bytes) === digest : bytes.length === asset.size);
      const path = join(cache, 'releases', release.tag_name, asset.name);
      files.push(
        publish(release.tag_name, asset.name, await cached(path, asset.browser_download_url, valid)),
      );
    }
    builds.push({
      id: release.tag_name,
      kind: 'release',
      label: release.tag_name,
      date: release.published_at,
      url: release.html_url,
      files,
    });
    console.log(`release ${release.tag_name}: ${files.length} files`);
  }
  return builds;
}

/** Mirrors the newest CI build of the main branch; zips come through nightly.link. */
async function mirrorBranch() {
  const { workflow_runs: runs } = await api(
    `/repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&status=success&per_page=20`,
  );
  for (const run of runs) {
    const { artifacts } = await api(`/repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`);
    const wanted = artifacts.filter((a) => /^openrtx-/.test(a.name) && !a.expired);
    if (wanted.length === 0) continue;
    const runDir = join(cache, 'runs', String(run.id));
    const files = [];
    for (const artifact of wanted) {
      const url = `https://nightly.link/${repo}/actions/runs/${run.id}/${artifact.name}.zip`;
      // An artifact never changes once uploaded; any zip that opens is the right one.
      const isZip = (bytes) => bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
      const zip = await cached(join(runDir, `${artifact.name}.zip`), url, isZip);
      for (const [name, data] of Object.entries(unzipSync(zip))) {
        const kept = mirroredName(artifact.name, name.split(/[\\/]/).pop());
        if (data.length > 0 && kept) files.push(publish(branch, kept, data));
      }
    }
    // Only the newest run is worth keeping.
    for (const old of existsSync(join(cache, 'runs')) ? readdirSync(join(cache, 'runs')) : []) {
      if (old !== String(run.id)) rmSync(join(cache, 'runs', old), { recursive: true, force: true });
    }
    console.log(`${branch} ${run.head_sha.slice(0, 8)}: ${files.length} files`);
    return [
      {
        id: branch,
        kind: 'master',
        label: branch,
        date: run.created_at,
        sha: run.head_sha,
        url: run.html_url,
        files,
      },
    ];
  }
  throw new Error(`no successful ${branch} run with firmware artifacts`);
}

/** The builds of one kind from the last successful mirror, republished from the cache. */
function fromLastMirror(kind) {
  if (!existsSync(lastPath)) return null;
  const last = JSON.parse(readFileSync(lastPath, 'utf8'));
  const builds = last.builds.filter((b) => b.kind === kind);
  if (builds.length === 0) return null;
  for (const build of builds) {
    for (const file of build.files) {
      const kept = join(cache, 'last', build.id, file.name);
      if (!existsSync(kept) || sha256(readFileSync(kept)) !== file.sha256) return null;
    }
  }
  for (const build of builds) {
    build.files = build.files.map((file) =>
      publish(build.id, file.name, readFileSync(join(cache, 'last', build.id, file.name))),
    );
  }
  return { builds, generated: last.generated };
}

/** Runs one source; when it fails, falls back to what the last successful mirror got. */
async function attempt(what, kind, source) {
  try {
    return { builds: await source(), fresh: true };
  } catch (error) {
    const last = fromLastMirror(kind);
    if (last) {
      console.warn(`WARNING: could not refresh ${what} (${error.message.split('\n')[0]}).`);
      console.warn(`WARNING: using the copy mirrored on ${last.generated} instead.`);
      return { builds: last.builds, fresh: false };
    }
    if (strict) throw error;
    console.warn(`warning: skipped ${what}: ${error.message.split('\n')[0]}`);
    return { builds: [], fresh: false };
  }
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const master = await attempt(`${branch} build`, 'master', mirrorBranch);
const releases = await attempt('releases', 'release', mirrorReleases);
// Releases first (newest first), then the development build.
const builds = [...releases.builds, ...master.builds];
const manifest = { generated: new Date().toISOString(), source: repo, builds };
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

// Remember this mirror as the fallback for the next one, unless it is itself a fallback.
if (master.fresh && releases.fresh) {
  rmSync(join(cache, 'last'), { recursive: true, force: true });
  for (const build of builds) {
    for (const file of build.files) {
      // A file can be in a folder of its build ("c62/zephyr.bin").
      const kept = join(cache, 'last', build.id, file.name);
      mkdirSync(dirname(kept), { recursive: true });
      writeFileSync(kept, readFileSync(join(outDir, build.id, file.name)));
    }
  }
  save(lastPath, JSON.stringify(manifest, null, 2));
}

const total = builds.reduce((count, b) => count + b.files.length, 0);
console.log(`wrote ${outDir}/manifest.json: ${builds.length} builds, ${total} files`);
if (strict && builds.length === 0) process.exit(1);
