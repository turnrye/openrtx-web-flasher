// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import tailwindcss from '@tailwindcss/vite';
import { buildDefines } from './vite.config.ts';

/**
 * The path the site is served under, with a slash at both ends: `/` on its own domain,
 * `/<repo>/` on a project Pages site, `/<repo>/pr-preview/pr-N/` for a preview. Astro
 * writes absolute links, so each place the site is published gets its own build.
 */
const base = `/${(process.env.SITE_BASE ?? '/').replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');

// The flasher and its three pages (site/pages/): the flasher, a Preact app, at the top,
// and the radios, what a backup keeps, and the licences and credits. The OpenRTX
// website, with the users' guide, is its own site: OpenRTX/openrtx.github.io.
export default defineConfig({
  // An empty SITE_URL, as an unset CI variable arrives, counts as none.
  site: process.env.SITE_URL === '' ? undefined : process.env.SITE_URL,
  base,
  trailingSlash: 'always',
  srcDir: './site',
  publicDir: './public',
  outDir: './dist',
  integrations: [preact()],
  vite: { define: buildDefines(), plugins: [tailwindcss()] },
});
