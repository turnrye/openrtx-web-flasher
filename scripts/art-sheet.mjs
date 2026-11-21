#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Renders every drawing in public/art/ side by side into one PNG, for reviewing the art.
 *
 *   node scripts/art-sheet.mjs [output.png] [--enter]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const art = fileURLToPath(new URL('../public/art/', import.meta.url));
const args = process.argv.slice(2);
const enter = args.includes('--enter');
const out = args.find((a) => !a.startsWith('--')) ?? 'art-sheet.png';
const files = readdirSync(art)
  .filter((f) => f.endsWith('.svg') && f.endsWith('-enter.svg') === enter)
  .sort();

// A page made with setContent may not load files from disk, so the drawings go in as data.
const cells = files
  .map((f) => {
    const data = readFileSync(art + f).toString('base64');
    const name = f.replace(/(-enter)?\.svg$/, '');
    return `<figure><img src="data:image/svg+xml;base64,${data}"><figcaption>${name}</figcaption></figure>`;
  })
  .join('');
const html = `<!doctype html><style>
  body { margin: 0; background: #000; color: #ccc; font: 14px sans-serif; display: flex; flex-wrap: wrap; }
  figure { margin: 8px; width: 240px; text-align: center; }
  img { width: 240px; height: 400px; object-fit: contain; }
</style>${cells}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1560, height: 900 } });
await page.setContent(html);
await page.waitForLoadState('networkidle');
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log(`wrote ${out}: ${files.length} drawings`);
