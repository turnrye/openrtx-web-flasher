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
        './site/styles/theme.css',
      ],
      social: [{ icon: 'github', label: 'OpenRTX on GitHub', href: 'https://github.com/OpenRTX/OpenRTX' }],
      editLink: { baseUrl: `${REPO}/edit/main/` },
      // Dark only, as the radio's own screen is: no theme switch, no stored choice.
      components: {
        ThemeSelect: './site/components/Empty.astro',
        ThemeProvider: './site/components/DarkOnly.astro',
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
        { label: 'Flash your radio', link: '/flash/' },
        { label: 'Start here', items: [{ slug: 'user_guide' }, { slug: 'dev_status' }] },
        {
          label: 'The flasher',
          collapsed: true,
          items: [
            { slug: 'flasher/backup-coverage' },
            { slug: 'flasher/dumper' },
            { slug: 'flasher/qa' },
            { slug: 'flasher/verification' },
            { slug: 'flasher/bench-notes' },
            { slug: 'flasher/hosting' },
          ],
        },
        { label: 'Radios', collapsed: true, items: [{ autogenerate: { directory: 'hardware' } }] },
        { label: 'M17', collapsed: true, items: [{ autogenerate: { directory: 'm17' } }] },
        {
          label: 'Developers',
          collapsed: true,
          items: [
            { slug: 'developers_guide' },
            { slug: 'compiling' },
            { slug: 'software' },
            { slug: 'binary_cps_format' },
            { slug: 'rtxlink' },
          ],
        },
        { label: 'News', collapsed: true, items: [{ autogenerate: { directory: 'posts' } }] },
        {
          label: 'Community',
          items: [{ slug: 'get_in_touch' }, { slug: 'contribute' }, { slug: 'licences' }],
        },
      ],
    }),
    preact(),
  ],
  vite: { define: buildDefines(), plugins: [tailwindcss()] },
});
