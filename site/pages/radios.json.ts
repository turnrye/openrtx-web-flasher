// SPDX-License-Identifier: GPL-3.0-or-later
// radios.json at the site's top: the flasher's radios for the OpenRTX website and anyone
// else (src/radios-json.ts has the shape). Written once, at build time.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { APIRoute } from 'astro';
import type { Manifest } from '../../src/firmware/builds.ts';
import { RADIOS } from '../../src/radios.ts';
import { buildRadiosJson } from '../../src/radios-json.ts';

export const prerender = true;

/** The mirrored firmware's list, or null when the build mirrored none. */
function manifest(): Manifest | null {
  try {
    return JSON.parse(
      readFileSync(join(process.cwd(), 'public', 'firmware', 'manifest.json'), 'utf8'),
    ) as Manifest;
  } catch {
    return null;
  }
}

export const GET: APIRoute = ({ site }) => {
  const base = import.meta.env.BASE_URL.replace(/\/?$/, '/');
  const flasher = site ? new URL(base, site).href : base;
  const release = manifest()?.builds.find((b) => b.kind === 'release');
  const body = buildRadiosJson(RADIOS, release, flasher, new Date().toISOString());
  return new Response(JSON.stringify(body, null, 2) + '\n', {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
