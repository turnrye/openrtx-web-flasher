// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Where the site's files are. The flasher is one page of a site that may be served from
 * a domain's root, from `/<repo>/` on a Pages host or from a pull request's preview
 * folder; the build knows which (`SITE_BASE`, astro.config.ts). The drawings, the
 * mirrored firmware and cskburn sit at the top of the site, not beside the page.
 */

/** The site's base path as the build has it, with a slash at the end. */
function basePath(): string {
  const base: string = import.meta.env.BASE_URL ?? '/';
  return base.endsWith('/') ? base : `${base}/`;
}

/** The absolute address of a file of the site, given its path from the site's top. */
export function siteUrl(path = ''): string {
  return new URL(basePath() + path.replace(/^\/+/, ''), document.baseURI).href;
}
