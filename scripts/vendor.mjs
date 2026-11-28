#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Fetches and builds everything this project takes from elsewhere that is not an npm
 * package, at the versions pinned in vendor.json. Nothing it produces is committed:
 *
 *   public/cskburn/             cskburn compiled to WebAssembly
 *   public/openrtx_logo.svg     the OpenRTX logo, editor metadata removed
 *   public/art/<radio>.svg      the radio drawings (scripts/art.mjs)
 *   public/screens/<kind>.png   OpenRTX's own screen, colour and monochrome, for the home page
 *
 * Downloads, checkouts, the Emscripten toolchain and the compiled cskburn are kept in the
 * per-user cache (scripts/cache.mjs), so once they are there this script needs no
 * network, and a second clone or worktree needs no second download. Every download is
 * retried, and a file is only used when its checksum matches the pin.
 *
 *   node scripts/vendor.mjs                fetch, verify, build what is missing or stale
 *   node scripts/vendor.mjs --update       also record new checksums in vendor.json
 *   node scripts/vendor.mjs --no-wasm      skip cskburn (no Emscripten needed)
 *   node scripts/vendor.mjs --needs-emsdk  print "true" when cskburn must be compiled, else "false"
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArt } from './art.mjs';
import { cacheDir, download, retry } from './cache.mjs';
import { importDocs } from './import-docs.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cache = cacheDir();
const pinsPath = join(root, 'vendor.json');
const pins = JSON.parse(readFileSync(pinsPath, 'utf8'));
const update = process.argv.includes('--update');
const noWasm = process.argv.includes('--no-wasm');
const glue = join(root, 'tools', 'cskburn-wasm');
/** Files of the old website, copied into public/ as they are: not pages, but addresses in use. */
const WEBSITE_FILES = ['emulator', '.well-known/matrix/server', 'favicon.ico'];

/** cskburn sources compiled in; the USB backend and its libusb are left out. */
const CSKBURN_SOURCES = [
  'cskburn/src/main.c',
  'cskburn/src/utils.c',
  'cskburn/src/verify.c',
  'cskburn/src/read_parts_bin.c',
  'cskburn/src/read_parts_hex.c',
  'cskburn/src/intelhex/intelhex.c',
  'libcskburn_serial/src/core.c',
  'libcskburn_serial/src/cmd.c',
  'libslip/src/slip.c',
  'libio/src/io.c',
  'libio/src/fsio.c',
  'libio/src/memio.c',
  'liblog/src/log.c',
  'liblog/src/errid.c',
  'liberrors/src/errors.c',
  'libportable/src/time_monotonic.c',
  'third/mbedtls/library/md5.c',
  'third/mbedtls/library/platform_util.c',
];
const CSKBURN_INCLUDES = [
  ...['libserial', 'libcskburn_serial', 'libslip', 'libio', 'liblog', 'liberrors', 'libportable'].map(
    (lib) => `${lib}/include`,
  ),
  'libcskburn_serial/src',
  'cskburn/src',
  'third/mbedtls/include',
  'third/mbedtls/library',
];
const BURNERS = ['castor', 'venus', 'arcs', 'venusa'];
const EMCC_FLAGS = [
  '-O2',
  '-DWITHOUT_USB',
  '-DGIT_INCREMENT=0',
  '-sASYNCIFY',
  '-sASYNCIFY_STACK_SIZE=65536',
  '-sALLOW_MEMORY_GROWTH',
  '-sMODULARIZE',
  '-sEXPORT_ES6',
  '-sINVOKE_RUN=0',
  '-sEXIT_RUNTIME=1',
  '-sEXPORTED_RUNTIME_METHODS=callMain,FS',
  '-sENVIRONMENT=web,node',
  '-sFORCE_FILESYSTEM',
];

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** Identifies one cskburn build: everything that goes into it, hashed. */
const cskburnStamp = sha256(
  JSON.stringify([pins.emsdk, pins.cskburn.commit, CSKBURN_SOURCES, CSKBURN_INCLUDES, BURNERS, EMCC_FLAGS]) +
    readFileSync(join(glue, 'serial_web.c'), 'utf8') +
    readFileSync(join(glue, 'override', 'msleep.h'), 'utf8'),
);
const builtDir = join(cache, 'cskburn-wasm', cskburnStamp);

/** Runs a command, echoing nothing unless it fails. */
function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...options });
  } catch (error) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${error.stderr || error.message}`, {
      cause: error,
    });
  }
}

/** Puts one pinned file in the cache, unless a copy with the right checksum is there already. */
async function fetchFile(name, pin) {
  const path = join(cache, 'files', name);
  if (!existsSync(path) || sha256(readFileSync(path)) !== pin.sha256) {
    const bytes = await download(pin.url);
    const actual = sha256(bytes);
    if (actual !== pin.sha256) {
      if (!update) {
        throw new Error(
          `${name}: checksum ${actual} does not match vendor.json (${pin.sha256 || 'none recorded'})`,
        );
      }
      pin.sha256 = actual;
      console.log(`${name}: recorded ${actual}`);
    }
    mkdirSync(join(cache, 'files'), { recursive: true });
    // Write beside the target and rename, so an interrupted run leaves no half file.
    writeFileSync(`${path}.part`, bytes);
    renameSync(`${path}.part`, path);
    console.log(`${name}: downloaded`);
  }
  return path;
}

/** Checks out `commit` of `repo` into the cache, without history, unless it is there already. */
async function checkout(name, repo, commit) {
  const dir = join(cache, name);
  const head = existsSync(join(dir, '.git')) ? run('git', ['-C', dir, 'rev-parse', 'HEAD']).trim() : '';
  if (head === commit) return dir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  run('git', ['-C', dir, 'init', '-q']);
  run('git', ['-C', dir, 'remote', 'add', 'origin', repo]);
  await retry(`${name} checkout`, () =>
    run('git', ['-C', dir, 'fetch', '-q', '--depth', '1', 'origin', commit]),
  );
  run('git', ['-C', dir, 'checkout', '-q', '--detach', 'FETCH_HEAD']);
  const got = run('git', ['-C', dir, 'rev-parse', 'HEAD']).trim();
  if (got !== commit) throw new Error(`${name}: got ${got}, pinned ${commit}`);
  console.log(`${name}: checked out ${commit.slice(0, 10)}`);
  return dir;
}

/** Writes the OpenRTX logo without Inkscape's metadata and its black background. */
function buildLogo(source) {
  const svg = readFileSync(source, 'utf8');
  let body = svg.slice(svg.indexOf('<g'), svg.lastIndexOf('</svg>'));
  body = body.replace(/<g\s[^>]*id="layer1"[\s\S]*?<\/g>/, '');
  body = body.replace(/\s(inkscape|sodipodi):[\w-]+="[^"]*"/g, '');
  body = body.replace(/fill-opacity:0\.997841/g, 'fill-opacity:1').replace(/\n\s*\n/g, '\n');
  const out =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<!-- OpenRTX logo, from ${pins.files['openrtx_logo.svg'].url}; editor metadata and background removed. -->\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">\n${body}</svg>\n`;
  writeFileSync(join(root, 'public', 'openrtx_logo.svg'), out);
}

/** Turns a binary into a C array, like cskburn's bin2c.py. */
function bin2c(input, output, name) {
  const bytes = readFileSync(input);
  const rows = [];
  for (let i = 0; i < bytes.length; i += 16) {
    rows.push(
      '\t' +
        Array.from(bytes.subarray(i, i + 16), (b) => `0x${b.toString(16).padStart(2, '0')}`).join(', ') +
        ',',
    );
  }
  writeFileSync(
    output,
    `#include <stdint.h>\n\nconst uint8_t ${name}[] = {\n${rows.join('\n')}\n};\n\nconst uint32_t ${name}_len = sizeof(${name});\n`,
  );
}

/** Compiles cskburn's serial flasher to WebAssembly with the pinned Emscripten, into the cache. */
async function compileCskburn() {
  const src = await checkout('cskburn', pins.cskburn.repo, pins.cskburn.commit);
  const emsdk = await checkout('emsdk', pins.emsdk.repo, pins.emsdk.commit);
  const emcc = join(emsdk, 'upstream', 'emscripten', 'emcc');
  if (!existsSync(emcc)) {
    console.log(`emsdk: installing Emscripten ${pins.emsdk.version} (about 1.8 GB unpacked, once)`);
    await retry('emsdk install', () =>
      run(join(emsdk, 'emsdk'), ['install', pins.emsdk.version], { stdio: 'inherit' }),
    );
  }
  run(join(emsdk, 'emsdk'), ['activate', pins.emsdk.version]);

  const build = join(cache, 'cskburn-build');
  rmSync(build, { recursive: true, force: true });
  mkdirSync(build, { recursive: true });
  for (const chip of BURNERS) {
    bin2c(
      join(src, 'libcskburn_serial', `burner_${chip}.bin`),
      join(build, `burner_serial_${chip}_img.c`),
      `burner_serial_${chip}`,
    );
  }
  const args = [
    ...EMCC_FLAGS,
    `-DGIT_TAG="web-${pins.cskburn.commit.slice(0, 7)}"`,
    `-I${join(glue, 'override')}`,
    ...CSKBURN_INCLUDES.map((dir) => `-I${join(src, dir)}`),
    ...CSKBURN_SOURCES.map((file) => join(src, file)),
    join(glue, 'serial_web.c'),
    ...BURNERS.map((chip) => join(build, `burner_serial_${chip}_img.c`)),
    '-o',
    join(build, 'cskburn.mjs'),
  ];
  // emsdk_env.sh sets up PATH and EM_CONFIG for the pinned toolchain.
  const quoted = [emcc, ...args].map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(' ');
  console.log(`cskburn: compiling ${pins.cskburn.commit.slice(0, 10)} with Emscripten ${pins.emsdk.version}`);
  run('bash', ['-c', `source '${join(emsdk, 'emsdk_env.sh')}' >/dev/null 2>&1 && ${quoted}`]);

  // What the tests check the uploaded RAM stub against.
  const info = {
    cskburn: pins.cskburn.commit,
    emscripten: pins.emsdk.version,
    burnerVenusSha256: sha256(readFileSync(join(src, 'libcskburn_serial', 'burner_venus.bin'))),
  };
  writeFileSync(join(build, 'build.json'), JSON.stringify(info, null, 2) + '\n');
  rmSync(builtDir, { recursive: true, force: true });
  mkdirSync(builtDir, { recursive: true });
  for (const file of ['cskburn.mjs', 'cskburn.wasm', 'build.json'])
    cpSync(join(build, file), join(builtDir, file));
  rmSync(build, { recursive: true, force: true });
}

/** Puts the compiled cskburn in public/cskburn/, compiling it first when the cache has no copy. */
async function buildCskburn() {
  if (!existsSync(join(builtDir, 'cskburn.wasm'))) await compileCskburn();
  const out = join(root, 'public', 'cskburn');
  rmSync(out, { recursive: true, force: true });
  cpSync(builtDir, out, { recursive: true });
  console.log(`cskburn: public/cskburn/ is build ${cskburnStamp.slice(0, 12)}`);
}

if (process.argv.includes('--needs-emsdk')) {
  console.log(String(!existsSync(join(builtDir, 'cskburn.wasm'))));
  process.exit(0);
}

mkdirSync(join(root, 'public'), { recursive: true });
const files = {};
for (const [name, pin] of Object.entries(pins.files)) files[name] = await fetchFile(name, pin);
if (update) writeFileSync(pinsPath, JSON.stringify(pins, null, 2) + '\n');

buildLogo(files['openrtx_logo.svg']);
const drawn = buildArt({ files, out: join(root, 'public', 'art') });
console.log(`art: ${drawn.length} drawings in public/art/`);
// The same screen captures, as they are, for the home page's screen frames.
mkdirSync(join(root, 'public', 'screens'), { recursive: true });
cpSync(files['screen-colour.png'], join(root, 'public', 'screens', 'colour.png'));
cpSync(files['screen-mono.png'], join(root, 'public', 'screens', 'mono.png'));
// The website's pages, for the site that Astro builds around the flasher.
const website = await checkout('website', pins.website.repo, pins.website.commit);
const docs = importDocs({
  source: website,
  out: join(root, 'site', 'content', 'docs'),
  edit: pins.website.edit,
});
console.log(`website: ${docs.pages} pages and ${docs.media} pictures in ${docs.out}/`);
// The website's files that are not pages but have addresses in use, so this site can
// take over openrtx.org: the emulator, Matrix's delegation for the domain, and the icon
// browsers ask for at the top.
for (const path of WEBSITE_FILES) {
  if (!existsSync(join(website, path))) throw new Error(`website: ${path} is missing at the pinned commit`);
  rmSync(join(root, 'public', path), { recursive: true, force: true });
  cpSync(join(website, path), join(root, 'public', path), { recursive: true });
}
console.log(`website: ${WEBSITE_FILES.join(', ')} in public/`);
// The flasher's own notes in docs/ are for whoever works on it: they stay there, read
// on the forge, and are not pages of the site.
if (noWasm) console.log('cskburn: skipped (--no-wasm)');
else await buildCskburn();
