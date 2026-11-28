// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What the home page shows that comes from elsewhere, read once at build time: the
 * firmware the build mirrored, the contributors scripts/community.mjs fetched, the
 * website's photos, and its news posts. Anything missing (an offline build, say) comes
 * back empty and the home page leaves that part out.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImageMetadata } from 'astro';
import { getCollection } from 'astro:content';
import { fileForRadio, type Build } from '../src/firmware/builds.ts';
import { RADIOS, type Radio } from '../src/radios.ts';

/** The site's top, with a slash at the end. */
export const top = import.meta.env.BASE_URL.replace(/\/?$/, '/');

/** Where people can send a photo or a correction without editing a file. */
export const SUGGEST_URL =
  'https://github.com/turnrye/openrtx-web-flasher/issues/new?template=docs-suggestion.yml';

/** Reads a JSON file under public/, or null when the build did not make it. */
function publicJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), 'public', path), 'utf8')) as T;
  } catch {
    return null;
  }
}

/** One person from GitHub's contributor list (scripts/community.mjs). */
export interface Contributor {
  login: string;
  url: string;
  /** Path of their picture under the site's top, or null when it could not be fetched. */
  picture: string | null;
  contributions: number;
}

/** Stars, start date and contributors of the firmware repository, or null without them. */
export const community = publicJson<{ stars: number; created?: string; contributors: Contributor[] }>(
  'community/community.json',
);

/** The newest OpenRTX release the build mirrored, or undefined without a mirror. */
export const latestRelease = publicJson<{ builds: Build[] }>('firmware/manifest.json')?.builds.find(
  (b) => b.kind === 'release',
);

/** Whether a radio has firmware in the newest release, as the flasher groups them. */
export function inRelease(radio: Radio): boolean {
  return latestRelease ? Boolean(fileForRadio(radio, latestRelease)) : true;
}

/** Every radio the flasher knows. */
export const radios = RADIOS;

/** A date as the site writes it: 4 Oct 2026. */
export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// The website's photos, imported so Astro can make them the size the page shows. The
// folder is filled by scripts/vendor.mjs from the pinned website.
const media = import.meta.glob<{ default: ImageMetadata }>(
  './content/docs/_media/*.{jpg,jpeg,JPEG,JPG,png}',
  {
    eager: true,
  },
);

/** A photo from the website's _media folder by file name, or undefined when it is not there. */
export function photo(name: string): ImageMetadata | undefined {
  return media[`./content/docs/_media/${name}`]?.default;
}

/** One news post: its address under the site's top, title and date. */
export interface Post {
  href: string;
  title: string;
  date: Date;
}

/**
 * The website's news posts, newest first. Their dates are in their file names: either
 * at the start (2025-10-05-announcing…) or at the end (…-20261019).
 */
export async function posts(): Promise<Post[]> {
  const entries = await getCollection('docs', (e) => e.id.startsWith('posts/'));
  return entries
    .map((e) => {
      const name = e.id.slice('posts/'.length);
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(name) ?? /(\d{4})(\d{2})(\d{2})$/.exec(name);
      return m
        ? { href: `${top}${e.id}/`, title: e.data.title, date: new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`) }
        : null;
    })
    .filter((p): p is Post => p !== null)
    .sort((a, b) => b.date.getTime() - a.date.getTime());
}
