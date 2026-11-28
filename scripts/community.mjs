#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Fetches who works on OpenRTX, for the home page: the firmware repository's star count
 * and its contributors with their GitHub pictures.
 *
 *   public/community/community.json        stars, the year it began, and each contributor's name and picture
 *   public/community/avatars/<id>.<ext>    the pictures, served from the site itself
 *
 * None of it is needed for the site to build. When GitHub cannot be reached the last
 * good copy in the cache (scripts/cache.mjs) is used, and with no copy the home page
 * leaves these parts out. It never fails the build.
 *
 *   node scripts/community.mjs [--out public] [--offline]
 *
 * Environment, as for scripts/mirror-firmware.mjs:
 *   GITHUB_TOKEN     optional; raises the API rate limit
 *   ORTX_REPO        the repository to ask about (default OpenRTX/OpenRTX)
 *   ORTX_GITHUB_API  API address, for testing the fall-back (default https://api.github.com)
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cacheDir, download } from './cache.mjs';

/** Size the pictures are asked for in, in pixels: twice the size the page shows them. */
const AVATAR_SIZE = 96;

/**
 * The people to show from GitHub's contributor list: no bots, no anonymous entries,
 * most contributions first.
 * @param {Array<Record<string, unknown>>} list the API's answer
 * @returns {{login: string, id: number, url: string, picture: string, contributions: number}[]}
 */
export function pickContributors(list) {
  return list
    .filter((c) => c && typeof c.login === 'string' && c.type !== 'Bot' && !c.login.endsWith('[bot]'))
    .map((c) => ({
      login: c.login,
      id: Number(c.id),
      url: String(c.html_url),
      picture: String(c.avatar_url),
      contributions: Number(c.contributions) || 0,
    }))
    .sort((a, b) => b.contributions - a.contributions || a.login.localeCompare(b.login));
}

/**
 * The file extension for a picture, from its first bytes; null when it is neither PNG,
 * JPEG, GIF nor WebP, so nothing unexpected is served from the site.
 * @param {Uint8Array} bytes
 * @returns {string | null}
 */
export function pictureType(bytes) {
  const starts = (...b) => b.every((v, i) => bytes[i] === v);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'png';
  if (starts(0xff, 0xd8, 0xff)) return 'jpg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'gif';
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45) return 'webp';
  return null;
}

/**
 * The address of a GitHub picture at the size the page uses.
 * @param {string} picture avatar_url from the API
 * @returns {string}
 */
export function sizedPicture(picture) {
  const url = new URL(picture);
  url.searchParams.set('s', String(AVATAR_SIZE));
  return url.href;
}

/** Writes `bytes` to `path` in one step, so an interrupted run leaves no half file. */
function save(path, bytes) {
  writeFileSync(`${path}.part`, bytes);
  renameSync(`${path}.part`, path);
}

/** Fetches the facts, falls back to the cache, and writes what it has. */
async function main() {
  const args = process.argv.slice(2);
  const outArg = args.indexOf('--out');
  const out = join(outArg >= 0 ? args[outArg + 1] : 'public', 'community');
  const offline = args.includes('--offline');
  const repo = process.env.ORTX_REPO || 'OpenRTX/OpenRTX';
  const apiBase = process.env.ORTX_GITHUB_API || 'https://api.github.com';
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'openrtx-web-flasher' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const cache = join(cacheDir(), 'community', repo.replace('/', '__'));
  const lastPath = join(cache, 'last.json');
  mkdirSync(join(cache, 'avatars'), { recursive: true });

  /** Calls the GitHub API and returns JSON. */
  const api = async (path) =>
    JSON.parse(new TextDecoder().decode(await download(`${apiBase}${path}`, headers)));

  let facts = null;
  if (!offline) {
    try {
      const about = await api(`/repos/${repo}`);
      const people = pickContributors(await api(`/repos/${repo}/contributors?per_page=100`));
      facts = {
        repo,
        fetched: new Date().toISOString(),
        stars: Number(about.stargazers_count) || 0,
        created: String(about.created_at ?? ''),
        people,
      };
      save(lastPath, JSON.stringify(facts, null, 2) + '\n');
    } catch (error) {
      console.warn(`community: GitHub did not answer (${String(error.message).split('\n')[0]})`);
    }
  }
  if (!facts && existsSync(lastPath)) {
    facts = JSON.parse(readFileSync(lastPath, 'utf8'));
    console.warn(`community: using the copy fetched ${facts.fetched}`);
  }
  rmSync(out, { recursive: true, force: true });
  if (!facts) {
    console.warn('community: nothing to show; the home page leaves out stars and contributors');
    return;
  }

  // Each picture is kept in the cache under a name made from its address, which GitHub
  // changes when the person changes their picture.
  mkdirSync(join(out, 'avatars'), { recursive: true });
  const contributors = [];
  for (const person of facts.people) {
    const address = sizedPicture(person.picture);
    const cached = join(cache, 'avatars', createHash('sha256').update(address).digest('hex').slice(0, 24));
    let bytes = existsSync(cached) ? readFileSync(cached) : null;
    if (!bytes && !offline) {
      try {
        bytes = await download(address, { 'User-Agent': 'openrtx-web-flasher' });
        save(cached, bytes);
      } catch (error) {
        console.warn(`community: no picture for ${person.login} (${String(error.message).split('\n')[0]})`);
      }
    }
    const type = bytes ? pictureType(bytes) : null;
    const file = type ? `avatars/${person.id}.${type}` : null;
    if (file) writeFileSync(join(out, file), bytes);
    contributors.push({
      login: person.login,
      url: person.url,
      picture: file,
      contributions: person.contributions,
    });
  }
  const result = {
    repo: facts.repo,
    fetched: facts.fetched,
    stars: facts.stars,
    created: facts.created,
    contributors,
  };
  writeFileSync(join(out, 'community.json'), JSON.stringify(result, null, 2) + '\n');
  const pictured = contributors.filter((c) => c.picture).length;
  console.log(
    `community: ${contributors.length} contributors (${pictured} with pictures), ${facts.stars} stars`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    // Never the reason a build fails: the page does without.
    console.warn(`community: ${String(error?.message ?? error)}`);
  });
}
