// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { convertPage, importDocs, plainSvg, slugFor } from './import-docs.mjs';

const EDIT = 'https://example.invalid/edit/master/';

/** Converts one page of a made-up website that has these files. */
function convert(file, text, files) {
  const pages = new Map(files.filter((f) => f.endsWith('.md')).map((f) => [f, slugFor(f)]));
  return convertPage(file, text, pages, (path) => files.includes(path), EDIT);
}

const SITE = [
  'README.md',
  'user_guide.md',
  'compiling.md',
  'hardware/md380.md',
  'hardware/hardware.md',
  'M17/m17.md',
  'posts/index.md',
  'posts/2025-10-05-release.md',
  '_media/logo.svg',
  '_media/photo.jpg',
];

describe('slugFor', () => {
  it('gives lower-case addresses, a folder for an index page, and "about" for the old home page', () => {
    expect(slugFor('user_guide.md')).toBe('user_guide');
    expect(slugFor('M17/m17.md')).toBe('m17/m17');
    expect(slugFor('posts/index.md')).toBe('posts');
    expect(slugFor('README.md')).toBe('about');
  });
});

describe('convertPage', () => {
  it('turns the first heading into the title and names the file to edit', () => {
    const { text } = convert('hardware/md380.md', '# MD-380\n\n## Device models\n- Tytera MD-380\n', SITE);
    expect(text).toBe(
      '---\ntitle: "MD-380"\neditUrl: "https://example.invalid/edit/master/hardware/md380.md"\n---\n\n## Device models\n- Tytera MD-380\n',
    );
  });

  it('names a page with no heading after its file', () => {
    expect(convert('compiling.md', 'Some text first.\n\n# Later heading\n', SITE).text).toContain(
      'title: "Compiling"',
    );
  });

  it('rewrites links between pages so they work under any base path', () => {
    const body = [
      '# Guide',
      '[build it](compiling.md) [the 380](hardware/md380.md) [a post](posts/2025-10-05-release)',
      '[posts](posts/index.md) [home](/) [flashing](compiling.md?id=flash-it) [same page](#top)',
      '[elsewhere](https://example.org/x.md)',
    ].join('\n');
    const { text } = convert('user_guide.md', body, SITE);
    expect(text).toContain('[build it](../compiling/)');
    expect(text).toContain('[the 380](../hardware/md380/)');
    expect(text).toContain('[a post](../posts/2025-10-05-release/)');
    expect(text).toContain('[posts](../posts/)');
    expect(text).toContain('[home](../about/)');
    expect(text).toContain('[flashing](../compiling/#flash-it)');
    expect(text).toContain('[same page](#top)');
    expect(text).toContain('[elsewhere](https://example.org/x.md)');
  });

  it('reads a link from the page’s folder first, then from the top, as docsify ends up doing', () => {
    // docsify's own posts page links "posts/…" from inside posts/.
    const { text } = convert('posts/index.md', '# Posts\n- [Release](posts/2025-10-05-release)\n', SITE);
    expect(text).toContain('[Release](../posts/2025-10-05-release/)');
    const deep = convert('hardware/md380.md', '# x\n[all](hardware.md) [guide](../user_guide.md)\n', SITE);
    expect(deep.text).toContain('[all](../../hardware/hardware/)');
    expect(deep.text).toContain('[guide](../../user_guide/)');
  });

  it('keeps pictures beside the pages and says which ones a page shows', () => {
    const body = '# x\n![photo](../_media/photo.jpg)\n[![logo](../_media/logo.svg)](https://example.org)\n';
    const page = convert('hardware/md380.md', body, SITE);
    expect(page.text).toContain('![photo](../_media/photo.jpg)');
    expect(page.text).toContain('[![logo](../_media/logo.svg)](https://example.org)');
    expect(page.media.sort()).toEqual(['_media/logo.svg', '_media/photo.jpg']);
    // From a page at the top, and from a link that climbs too far.
    const top = convert('user_guide.md', '# x\n![a](_media/photo.jpg) ![b](../_media/photo.jpg)\n', SITE);
    expect(top.text).toContain('![a](./_media/photo.jpg) ![b](./_media/photo.jpg)');
  });

  it('leaves a link to something the website does not have as it is', () => {
    expect(convert('user_guide.md', '# x\n[gone](nowhere.md)\n', SITE).text).toContain('[gone](nowhere.md)');
  });

  it('writes code fence languages in lower case', () => {
    expect(convert('compiling.md', '# x\n```C\nint a;\n```\n', SITE).text).toContain('```c\nint a;');
  });
});

describe('plainSvg', () => {
  it('drops the document type and the editor’s copy of the drawing, and nothing else', () => {
    const svg =
      '<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<svg width="4px" height="2px" content="&lt;mxfile&gt;big&lt;/mxfile&gt;"><rect content="kept"/></svg>';
    expect(plainSvg(svg)).toBe(
      '<?xml version="1.0"?>\n<svg width="4px" height="2px"><rect content="kept"/></svg>',
    );
  });
});

describe('importDocs', () => {
  const root = mkdtempSync(join(tmpdir(), 'import-docs-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('writes pages and the pictures they show, lists them to be ignored, and replaces them next time', () => {
    const source = join(root, 'site');
    const out = join(root, 'out');
    for (const dir of ['hardware', '_media', 'M17']) mkdirSync(join(source, dir), { recursive: true });
    mkdirSync(out, { recursive: true });
    writeFileSync(join(source, 'README.md'), '# The project\n![logo](_media/logo.svg)\n');
    writeFileSync(join(source, 'user_guide.md'), '# Guide\n[380](hardware/md380.md)\n');
    writeFileSync(join(source, 'hardware/md380.md'), '# MD-380\n![photo](../_media/photo.jpg)\n');
    writeFileSync(join(source, 'M17/old.md'), '<meta http-equiv="Refresh" content="0; url=/x">\n');
    writeFileSync(join(source, '_sidebar.md'), '* [x](user_guide.md)\n');
    writeFileSync(join(source, '_media/logo.svg'), '<svg width="1" height="1"></svg>');
    writeFileSync(join(source, '_media/photo.jpg'), 'jpg');
    writeFileSync(join(source, '_media/unused.png'), 'png');
    // A page written here by hand, with the same address as one of the website's.
    writeFileSync(join(out, 'user_guide.mdx'), 'ours');

    const first = importDocs({ source, out, edit: EDIT });
    expect(first.pages).toBe(2);
    expect(first.media).toBe(2);
    expect(readFileSync(join(out, 'about.md'), 'utf8')).toContain('title: "The project"');
    expect(readFileSync(join(out, 'hardware/md380.md'), 'utf8')).toContain('![photo](../_media/photo.jpg)');
    expect(readFileSync(join(out, 'user_guide.mdx'), 'utf8')).toBe('ours');
    expect(existsSync(join(out, 'user_guide.md'))).toBe(false);
    expect(existsSync(join(out, '_media/unused.png'))).toBe(false);
    expect(existsSync(join(out, 'm17/old.md'))).toBe(false);
    const ignored = readFileSync(join(out, '.gitignore'), 'utf8');
    expect(ignored).toContain('/about.md');
    expect(ignored).toContain('/hardware/md380.md');
    expect(ignored).toContain('/_media/');
    expect(ignored).not.toContain('user_guide');

    // A page that went away upstream goes away here too; the hand-written one stays.
    rmSync(join(source, 'hardware/md380.md'));
    importDocs({ source, out, edit: EDIT });
    expect(existsSync(join(out, 'hardware/md380.md'))).toBe(false);
    expect(readFileSync(join(out, 'user_guide.mdx'), 'utf8')).toBe('ours');
  });
});
