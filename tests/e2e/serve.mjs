// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Serves dist/ for the browser tests, with nothing but Node, under the path the site was
 * built for. Serving under a sub-path, like a Pages host does for a project site or a
 * preview, makes any absolute URL in the build that ignores the base fail loudly.
 *
 *   node tests/e2e/serve.mjs [port] [path]
 *
 * The path is the second argument (playwright.config.ts passes it), else SITE_BASE as
 * astro.config.ts reads it, else /sub/path/. An empty SITE_BASE, as an unset CI variable
 * arrives, counts as not set.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../dist/', import.meta.url));
const port = Number(process.argv[2] || 4173);
const asked = process.argv[3] || process.env.SITE_BASE || '/sub/path/';
/** The path with one slash at each end: "x" and "/x/y" become "/x/" and "/x/y/". */
const prefix = `/${asked.replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

if (!existsSync(join(root, 'flash', 'index.html'))) {
  console.error(
    'dist/flash/index.html is missing: build the site first (SITE_BASE=/sub/path npx astro build).',
  );
  process.exit(1);
}
if (prefix === '/') {
  // A site built for the top of its own domain can only be served there.
  console.warn('Serving at the top of the host: absolute URLs that ignore the base are not caught.');
}

createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://x').pathname);
  if (!path.startsWith(prefix)) {
    response.writeHead(404).end('outside the site');
    return;
  }
  let file = normalize(join(root, path.slice(prefix.length)));
  if (!file.startsWith(root)) {
    response.writeHead(403).end();
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) {
    response.writeHead(404).end('not found');
    return;
  }
  response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(response);
}).listen(port, () => console.log(`serving dist/ at http://localhost:${port}${prefix}`));
