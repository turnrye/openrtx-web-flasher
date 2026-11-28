// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import starlight from '@astrojs/starlight';
import tailwindcss from '@tailwindcss/vite';
import { buildDefines } from './vite.config.ts';

/**
 * The path the site is served under, with a slash at both ends: `/` on its own domain,
 * `/<repo>/` on a project Pages site, `/<repo>/pr-preview/pr-N/` for a preview. Astro
 * writes absolute links, so each place the site is published gets its own build.
 */
const base = `/${(process.env.SITE_BASE ?? '/').replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');

/** The repository pages are edited in; imported pages name their own in front matter. */
const REPO = 'https://github.com/turnrye/openrtx-web-flasher';

// The whole site: the OpenRTX pages and docs (Starlight, Markdown under
// site/content/docs/) and the flasher, a Preact app on one of those pages.
export default defineConfig({
  // An empty SITE_URL, as an unset CI variable arrives, counts as none.
  site: process.env.SITE_URL === '' ? undefined : process.env.SITE_URL,
  base,
  trailingSlash: 'always',
  // Addresses the old website answered with a redirect of its own; every other old
  // address is a page here under the same name. Astro does not put the base in front of a
  // destination, so it is written in.
  redirects: {
    '/md380_mods': `${base}m17/md380_mods/`,
    '/mduv380_mods': `${base}m17/mduv380_mods/`,
  },
  srcDir: './site',
  publicDir: './public',
  outDir: './dist',
  integrations: [
    starlight({
      title: 'OpenRTX',
      description: 'Free and open source firmware for digital amateur radios.',
      logo: { src: './public/openrtx_logo.svg', alt: '' },
      favicon: '/openrtx_logo.svg',
      customCss: [
        '@fontsource/ubuntu/latin-400.css',
        '@fontsource/ubuntu/latin-500.css',
        '@fontsource/ubuntu/latin-700.css',
        '@fontsource/ubuntu-mono/latin-400.css',
        '@fontsource/vt323/latin-400.css',
        './site/styles/theme.css',
      ],
      social: [{ icon: 'github', label: 'OpenRTX on GitHub', href: 'https://github.com/OpenRTX/OpenRTX' }],
      editLink: { baseUrl: `${REPO}/edit/main/` },
      // Dark only, as the radio's own screen is: no theme switch, no stored choice.
      components: {
        ThemeSelect: './site/components/Empty.astro',
        ThemeProvider: './site/components/DarkOnly.astro',
        Footer: './site/components/Footer.astro',
        // Only the home page has a hero: its own, with a photo and the radio's screen.
        Hero: './site/components/home/Hero.astro',
      },
      head: [
        {
          // The old site was docsify, whose pages were `/#/page?id=heading`. Those
          // links are all over the firmware's README and the forums; send them on.
          tag: 'script',
          content: `(function(){var h=location.hash;if(h.indexOf('#/')!==0)return;var p=h.slice(2).split('?');var path=p[0].replace(/\\.md$/,'').replace(/^\\/+|\\/+$/g,'').toLowerCase();var id=/(?:^|&)id=([^&]+)/.exec(p[1]||'');location.replace(${JSON.stringify(base)}+(path?path+'/':'')+(id?'#'+id[1]:''));})();`,
        },
      ],
      sidebar: [
        // The flasher and the pages about it, so they never read as OpenRTX's own docs.
        {
          label: 'Flash your radio',
          items: [
            { label: 'Flash your radio', link: '/flash/' },
            { slug: 'flash/radios' },
            { slug: 'flash/backups' },
            { slug: 'flash/credits' },
          ],
        },
        // Below: the old website's pages, each one reachable as it was there.
        {
          label: 'Users',
          items: [
            { slug: 'user_guide' },
            { slug: 'dev_status' },
            { slug: 'accessibility' },
            { label: 'M17', collapsed: true, items: [{ autogenerate: { directory: 'm17' } }] },
          ],
        },
        { label: 'Radios', collapsed: true, items: [{ autogenerate: { directory: 'hardware' } }] },
        {
          label: 'Developers',
          collapsed: true,
          items: [
            // The developers' guide, then its pages in its own order, then the references.
            { slug: 'developers_guide' },
            { slug: 'compiling' },
            { slug: 'tests' },
            { slug: 'linux' },
            { slug: 'software' },
            { slug: 'nvm' },
            { slug: 'software_modes' },
            { slug: 'coding_style' },
            { slug: 'peripheral_table' },
            { slug: 'rtxlink' },
            { slug: 'website' },
            { slug: 'binary_cps_format' },
            { slug: 'at1846_registers' },
            { slug: 'docrepository' },
            { label: 'OpenRTX-external-docs', link: 'https://github.com/OpenRTX/OpenRTX-external-docs' },
          ],
        },
        {
          label: 'News',
          collapsed: true,
          items: [
            { slug: 'posts', label: 'All posts' },
            { autogenerate: { directory: 'posts' } },
            { slug: 'hackathon', label: 'Hackathon (Jan 31, before FOSDEM)' },
          ],
        },
        {
          label: 'Project',
          items: [
            { slug: 'about', label: 'About OpenRTX' },
            { slug: 'get_in_touch' },
            { slug: 'contribute' },
          ],
        },
      ],
    }),
    preact(),
  ],
  vite: { define: buildDefines(), plugins: [tailwindcss()] },
});
