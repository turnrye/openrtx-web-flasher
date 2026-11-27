// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * cskburn for the command line (Retevis C62 / C2).
 *
 * The page runs LISTENAI's cskburn as WebAssembly, which takes a 1.8 GB toolchain to
 * build. The command line runs LISTENAI's own release of the same commit instead: the
 * program is downloaded once into the per-user cache and checked against the checksum
 * in vendor.json. It is handed to src/flash/csk.ts dressed as the WebAssembly module,
 * so what to ask cskburn for and how to read its answers stays in that one place.
 *
 * A native program cannot talk to a simulated serial port, so the simulated C62 runs
 * the WebAssembly build, where a checkout has one.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import { cacheDir, download } from '../scripts/cache.mjs';
import type { CskModuleLoader } from '../src/flash/csk.ts';
import { FlashError } from '../src/flash/types.ts';
import pins from '../vendor.json' with { type: 'json' };

/** A program pinned in vendor.json under "tools": one archive per platform. */
export interface ToolPin {
  version: string;
  builds: Record<string, { url: string; sha256: string } | undefined>;
}

/** The cskburn release the command line runs. */
export const CSKBURN_PIN: ToolPin = pins.tools.cskburn;

/** "darwin-arm64", "linux-x64", "win32-x64": how vendor.json names this computer. */
export function platformName(): string {
  return `${process.platform}-${process.arch}`;
}

/**
 * The pinned cskburn for `platform`, downloaded into `cache` unless it is there already.
 * Null when no build is pinned for the platform. The archive is refused when it does not
 * match its checksum.
 */
export async function pinnedCskburn(
  pin: ToolPin = CSKBURN_PIN,
  platform = platformName(),
  cache = cacheDir(),
  get: (url: string) => Promise<Uint8Array> = download,
): Promise<string | null> {
  const build = pin.builds[platform];
  if (!build) return null;
  const name = platform.startsWith('win32') ? 'cskburn.exe' : 'cskburn';
  const dir = join(cache, 'tools', `cskburn-${pin.version}-${platform}`);
  const binary = join(dir, name);
  if (existsSync(binary)) return binary;

  const archive = await get(build.url).catch((e: unknown) => {
    throw new FlashError(
      `Could not download cskburn (${e instanceof Error ? e.message.split('\n')[0] : String(e)}). ` +
        'Check your connection, or name a cskburn you already have with --cskburn.',
    );
  });
  const actual = createHash('sha256').update(archive).digest('hex');
  if (actual !== build.sha256) {
    throw new FlashError(
      `The cskburn download does not match its checksum (got ${actual}), so it was not used.`,
    );
  }
  // Unpack beside the target and rename, so an interrupted run leaves nothing half done.
  const work = `${dir}.part`;
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  // Either archive holds the one program and nothing else; only that is taken out.
  if (build.url.endsWith('.zip')) {
    const data = unzipSync(archive, { filter: (file) => file.name === name })[name];
    if (data) writeFileSync(join(work, name), data);
  } else {
    writeFileSync(join(work, 'cskburn.tar.xz'), archive);
    try {
      execFileSync('tar', ['-xJf', 'cskburn.tar.xz', name], { cwd: work, stdio: 'ignore' });
    } catch {
      // Reported below: the program is not there.
    }
    rmSync(join(work, 'cskburn.tar.xz'));
  }
  if (!existsSync(join(work, name))) {
    rmSync(work, { recursive: true, force: true });
    throw new FlashError(
      'Could not unpack the cskburn download. Install cskburn yourself and name it with --cskburn.',
    );
  }
  chmodSync(join(work, name), 0o755);
  rmSync(dir, { recursive: true, force: true });
  renameSync(work, dir);
  return binary;
}

/** The parts of an Emscripten module that src/flash/csk.ts uses. */
interface ModuleShape {
  FS: { writeFile(path: string, data: Uint8Array): void; readFile(path: string): Uint8Array };
  callMain(args: string[]): void;
  onExit?: (code: number) => void;
  stop?: () => void;
}

/**
 * The private folders of the runs still going. One can hold a radio's backup, so each is
 * removed as soon as its run is over, and whatever is left when the process ends.
 */
const folders = new Set<string>();
let watchingExit = false;

/** A new private folder for one cskburn run. */
function runFolder(): string {
  if (!watchingExit) process.once('exit', () => folders.forEach(dropFolder));
  watchingExit = true;
  const dir = mkdtempSync(join(tmpdir(), 'cskburn-'));
  folders.add(dir);
  return dir;
}

/** Removes a run's folder and what is in it. */
function dropFolder(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  folders.delete(dir);
}

/** The output callbacks csk.ts gives the module: one character code at a time. */
interface ModuleOptions {
  stdout?: (code: number | null) => void;
  stderr?: (code: number | null) => void;
}

/** Hands text to one of the module's output callbacks. */
function print(to: ModuleOptions['stdout'], text: Uint8Array | string): void {
  for (const byte of typeof text === 'string' ? Buffer.from(text) : text) to?.(byte);
}

/**
 * What cskburn is asked to read between giving the chip's ID and writing, when csk.ts
 * asks for both in one run (a backup being restored): 16 KiB from the start of the flash.
 * The real program does not wait for csk.ts to read what it printed, so without this it
 * would have begun to erase before a run for the wrong radio could be ended. The read
 * changes nothing and takes over a second at 115200 baud; ending the program takes
 * milliseconds.
 */
const GUARD_READ = ['--read', '0x0:0x4000:guard.bin'];

/**
 * A cskburn "module" that runs the program at `binary` on the serial port `port`.
 *
 * It stands where the WebAssembly module stands: csk.ts writes the images into its file
 * system, calls its main with cskburn's arguments and reads what cskburn printed. Here
 * the file system is a private folder, `-s webserial` becomes the real port, and main is
 * the real program.
 */
export function nativeCskburn(binary: string, port: string): CskModuleLoader {
  return () =>
    Promise.resolve((options: ModuleOptions) => {
      const dir = runFolder();
      /** A path in the module's file system ("/part0.bin") as a file in the folder. */
      const local = (path: string) => join(dir, path.replace(/^\/+/, ''));
      /** The images csk.ts put in the file system, to be written to the radio. */
      const images = new Set<string>();
      /** Ends the program if it is still running; set while it runs. */
      let kill: (() => void) | null = null;
      const module: ModuleShape = {
        // A run stopped early (the radio is already backed up, or is not the one a backup
        // is of) must not leave cskburn going on, holding the port.
        stop: () => kill?.(),
        FS: {
          writeFile: (path, data) => {
            images.add(path);
            writeFileSync(local(path), data);
          },
          // What a read left behind is the last thing csk.ts wants from a run.
          readFile: (path) => {
            const data = new Uint8Array(readFileSync(local(path)));
            dropFolder(dir);
            return data;
          },
        },
        callMain(args) {
          // cskburn runs in the folder, so file names need no path: "0x0:0x400000:read.bin"
          // stays free of the colon a Windows path would bring.
          // A write that csk.ts may have to stop once it has seen the chip's ID.
          const guarded = args.includes('--chip-id') && args.some((arg) => images.has(arg));
          const argv = args.flatMap((arg, i) => [
            args[i - 1] === '-s' ? port : arg.replace(/(^|:)\/([^/:]+)$/, '$1$2'),
            ...(guarded && arg === '--chip-id' ? GUARD_READ : []),
          ]);
          const child = spawn(binary, argv, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
          let ended = false;
          kill = () => child.kill();
          // Nor may it outlive this program.
          const atExit = () => child.kill();
          process.once('exit', atExit);
          /** Passes the exit code on, once. Only a read that worked leaves something to fetch. */
          const end = (code: number) => {
            if (ended) return;
            ended = true;
            kill = null;
            process.off('exit', atExit);
            if (code !== 0 || !args.includes('--read')) dropFolder(dir);
            module.onExit?.(code);
          };
          child.stdout.on('data', (chunk: Uint8Array) => print(options.stdout, chunk));
          child.stderr.on('data', (chunk: Uint8Array) => print(options.stderr, chunk));
          child.on('error', (error) => {
            print(options.stderr, `ERROR: could not run ${binary}: ${error.message}\n`);
            end(127);
          });
          child.on('close', (code) => end(code ?? 1));
        },
      };
      return Promise.resolve(module);
    });
}

/** The folder of this package: the nearest one above this file with a package.json. */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'package.json')) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}

/**
 * The WebAssembly cskburn the page runs, for the simulated C62: the one `npm run vendor`
 * put in public/cskburn/ of this checkout, else the newest build in the per-user cache.
 */
export function wasmCskburn(root = packageRoot(), cache = cacheDir()): CskModuleLoader {
  return async () => {
    const built = join(cache, 'cskburn-wasm');
    const cached = existsSync(built)
      ? readdirSync(built)
          .map((name) => join(built, name))
          .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      : [];
    const dir = [join(root, 'public', 'cskburn'), ...cached].find((d) => existsSync(join(d, 'cskburn.mjs')));
    if (!dir) {
      throw new FlashError(
        'The simulated C62 runs the WebAssembly build of cskburn, and this computer has none. ' +
          'In a checkout of the project, "npm run vendor" builds it.',
      );
    }
    const module = (await import(/* @vite-ignore */ pathToFileURL(join(dir, 'cskburn.mjs')).href)) as {
      default: Awaited<ReturnType<CskModuleLoader>>;
    };
    return module.default;
  };
}
