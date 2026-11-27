// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Copies the pages of the OpenRTX website into this site.
 *
 * Until the two projects are one repository, the website's pages stay where they are
 * written today, OpenRTX/openrtx.github.io, and scripts/vendor.mjs checks that
 * repository out at the commit pinned in vendor.json. This turns its docsify pages into
 * pages Starlight builds:
 *
 *   - the first heading becomes the `title:` line every page here starts with;
 *   - links between pages, which docsify reads from the site's top or from the page's
 *     folder as it finds them, become links that work wherever the site is served;
 *   - pictures are copied next to the pages, and only the ones a page shows;
 *   - each page's "Edit page" link goes to the file it came from.
 *
 * Everything it writes under the output folder is listed in a .gitignore there, so
 * copies are never committed here and are replaced on every run.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, posix, relative } from 'node:path';

/** Files of the website that are not pages of their own. */
const SKIP = new Set(['_sidebar.md', '_coverpage.md']);

/** The website's home page, README.md, gets a name of its own here: this site has its own front page. */
const HOME = { from: 'README.md', slug: 'about' };

/** Every Markdown file under `dir`, as paths from `dir` with forward slashes. */
function markdownFiles(dir, prefix = '') {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return entry.name.startsWith('.') ? [] : markdownFiles(dir, path);
    return entry.name.endsWith('.md') ? [path] : [];
  });
}

/** The address of a page, from the site's top, for the file it comes from: lower case, no extension. */
export function slugFor(file) {
  if (file === HOME.from) return HOME.slug;
  const slug = file
    .replace(/\.md$/, '')
    .toLowerCase()
    .replace(/(^|\/)index$/, '');
  return slug.replace(/\/$/, '');
}

/** A YAML string, quoted. */
function yaml(text) {
  return JSON.stringify(text);
}

/** Splits a link target into its path, the heading it points at, and the rest docsify allows. */
function splitTarget(target) {
  const [beforeHash, hash = ''] = target.split('#');
  const [path, query = ''] = beforeHash.split('?');
  const id = /(?:^|&)id=([^&]+)/.exec(query)?.[1] ?? '';
  return { path, anchor: id || hash };
}

/**
 * Turns one docsify page into a Starlight page.
 *
 * `file` is the page's path in the website; `pages` maps every page's path to its slug;
 * `hasFile(path)` says whether the website has that file. Returns the new text and the
 * pictures the page shows, as paths in the website.
 */
export function convertPage(file, text, pages, hasFile, edit) {
  const dir = posix.dirname(file) === '.' ? '' : posix.dirname(file);
  const slug = pages.get(file);
  // A page's address ends in a slash, so its own folder is one level below its slug.
  const depth = slug === '' ? 0 : slug.split('/').length;
  const up = '../'.repeat(depth);
  const media = new Set();

  /** The website file a link means: docsify takes it from the page's folder or from the top. */
  const resolve = (path) => {
    const clean = path.replace(/^\.\//, '');
    const candidates = path.startsWith('/')
      ? [clean.replace(/^\/+/, '')]
      : [
          posix.normalize(posix.join(dir, clean)),
          posix.normalize(clean),
          // A link that climbs above the site's top ends up at the top in a browser.
          clean.replace(/^(\.\.\/)+/, ''),
        ];
    for (const base of candidates) {
      for (const candidate of [base, `${base}.md`, `${base}/index.md`, `${base}/README.md`]) {
        if (candidate && !candidate.startsWith('..') && hasFile(candidate)) return candidate;
      }
    }
    return null;
  };

  /** Rewrites one link or picture target; leaves alone what it does not understand. */
  const rewrite = (target, isImage) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('//'))
      return target;
    const { path, anchor } = splitTarget(target);
    if (path === '/' || path === '') return anchor ? `#${anchor}` : `${up}${HOME.slug}/`;
    const found = resolve(path);
    if (found === null) return target;
    if (pages.has(found)) {
      const to = pages.get(found);
      return `${up}${to ? `${to}/` : ''}${anchor ? `#${anchor}` : ''}`;
    }
    if (isImage || !found.endsWith('.md')) {
      media.add(found);
      // Pictures sit beside the pages, in the folders the website keeps them in.
      const fromDir = posix.dirname(slugFile(slug));
      const there = posix.relative(fromDir === '.' ? '' : fromDir, found) || found;
      return there.startsWith('.') ? there : `./${there}`;
    }
    return target;
  };

  let body = text.replace(/\r\n/g, '\n');
  // docsify's cover and comments at the very top are not content.
  body = body.replace(/^(\s*<!--[\s\S]*?-->\s*)+/, '');
  let title = '';
  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(body);
  // Only a heading before any other text is the page's title.
  if (heading && body.slice(0, heading.index).trim() === '') {
    title = heading[1].replace(/[*_`]/g, '').trim();
    body = body.slice(heading.index + heading[0].length);
  }
  if (!title) title = titleFromName(file);

  /** Rewrites every link and picture in `source`, and those inside a link's own text. */
  const relink = (source) =>
    source.replace(
      /(!?)\[((?:[^\][]|\[[^\]]*\])*)\]\(\s*([^)\s]+)((?:\s+[^)]*)?)\)/g,
      (all, bang, label, target, rest) => {
        // docsify's own options after the address (":include", ":size=…") mean nothing here.
        const kept = /^\s+["']/.test(rest) && !/:\w/.test(rest) ? rest : '';
        return `${bang}[${relink(label)}](${rewrite(target, bang === '!')}${kept})`;
      },
    );
  body = relink(body);
  // The highlighter knows languages by their lower-case names.
  body = body.replace(
    /^(\s*```)([A-Za-z][\w+-]*)\s*$/gm,
    (all, fence, language) => fence + language.toLowerCase(),
  );

  const front = ['---', `title: ${yaml(title)}`];
  if (edit) front.push(`editUrl: ${yaml(`${edit}${file}`)}`);
  front.push('---', '');
  return { text: `${front.join('\n')}\n${body.replace(/^\n+/, '')}`, media: [...media] };
}

/**
 * An SVG as the site's image step can read it: without the document type line, and
 * without the copy of the drawing's source that diagrams.net keeps in a `content`
 * attribute of the first tag. What is drawn stays as it is.
 */
export function plainSvg(svg) {
  return svg.replace(/<!DOCTYPE[^>]*>\s*/i, '').replace(/(<svg\b[^>]*?)\scontent="[^"]*"/i, '$1');
}

/** The file a page is written to, from the output folder. */
export function slugFile(slug) {
  return slug === '' ? 'index.md' : `${slug}.md`;
}

/** A title for a page that has no heading: its file name, in words. */
function titleFromName(file) {
  const name = posix.basename(file, '.md').replace(/[_-]+/g, ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Imports the website checked out at `source` into `out` (site/content/docs).
 * `edit` is the address a page's file is edited at, up to and including the branch.
 * Returns what it wrote, for the log.
 */
export function importDocs({ source, out, edit }) {
  const files = markdownFiles(source).filter((file) => !SKIP.has(file));
  // Pages that only send the reader elsewhere (a <meta refresh>) are not carried over.
  const texts = new Map(files.map((file) => [file, readFileSync(join(source, file), 'utf8')]));
  const kept = files.filter((file) => !/^\s*<meta\s+http-equiv="refresh"/i.test(texts.get(file)));
  const pages = new Map(kept.map((file) => [file, slugFor(file)]));
  const hasFile = (path) => existsSync(join(source, path));

  // Start clean: remove what the last run wrote.
  const ignore = join(out, '.gitignore');
  if (existsSync(ignore)) {
    for (const line of readFileSync(ignore, 'utf8').split('\n')) {
      const path = line.trim().replace(/^\//, '');
      if (path && !path.startsWith('#') && path !== '.gitignore')
        rmSync(join(out, path), { recursive: true, force: true });
    }
  }

  const written = [];
  const media = new Set();
  for (const file of kept) {
    const slug = pages.get(file);
    const target = slugFile(slug);
    // A page written here by hand wins over the website's page of the same name.
    if (['md', 'mdx'].some((ext) => existsSync(join(out, target.replace(/\.md$/, `.${ext}`))))) continue;
    const page = convertPage(file, texts.get(file), pages, hasFile, edit);
    mkdirSync(dirname(join(out, target)), { recursive: true });
    writeFileSync(join(out, target), page.text);
    written.push(target);
    page.media.forEach((m) => media.add(m));
  }
  for (const file of media) {
    mkdirSync(dirname(join(out, file)), { recursive: true });
    if (extname(file).toLowerCase() === '.svg') {
      writeFileSync(join(out, file), plainSvg(readFileSync(join(source, file), 'utf8')));
    } else {
      copyFileSync(join(source, file), join(out, file));
    }
  }

  const folders = new Set([...media].map((file) => file.split('/')[0]).filter((top) => extname(top) === ''));
  const loose = [...media].filter((file) => !file.includes('/'));
  writeFileSync(
    ignore,
    [
      '# Written by scripts/import-docs.mjs: pages and pictures copied from the OpenRTX',
      '# website at build time. Edit them in that repository, not here.',
      '/.gitignore',
      ...written.map((file) => `/${file}`),
      ...[...folders].map((folder) => `/${folder}/`),
      ...loose.map((file) => `/${file}`),
      '',
    ].join('\n'),
  );
  return { pages: written.length, media: media.size, out: relative(process.cwd(), out) };
}
