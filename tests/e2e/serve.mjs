// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Serves dist/ under /sub/path/ for the browser tests, with nothing but Node. Serving
 * under a sub-path, like a Pages host does for a project site or a preview, makes any
 * absolute URL in the build fail loudly.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../dist/', import.meta.url));
const prefix = '/sub/path/';
const port = Number(process.argv[2] || 4173);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

if (!existsSync(join(root, 'index.html'))) {
  console.error('dist/index.html is missing: run ci/build.sh (or npm run build) first.');
  process.exit(1);
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
