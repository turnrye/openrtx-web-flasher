// SPDX-License-Identifier: GPL-3.0-or-later
/** Turns the words after `openrtx-flasher` into a command and its options. */
import { parseArgs } from 'node:util';

/** What the help shows. */
export const USAGE = `openrtx-flasher: back up and flash radios with OpenRTX from a terminal.

  openrtx-flasher radios [radio]             the radios, or what one of them needs
  openrtx-flasher firmware                   the releases and the development build
  openrtx-flasher fetch <radio> <firmware>   save a radio's firmware files
  openrtx-flasher backup <radio>             read the radio into a backup zip
  openrtx-flasher flash <radio> <firmware>   write firmware, or a backup zip, to the radio
  openrtx-flasher ports                      the serial ports on this computer

<radio> is a name from "radios", such as c62 or mduv3x0.
<firmware> is one of:
  release            the current release
  v0.4.5             a past release
  master             the development build (the latest CI build of master)
  588, my-branch, owner:branch, or a github.com pull request or branch address
                     the CI build of a pull request, branch or fork
  a file             firmware, a CI zip, or a backup zip made by "backup" or the web page

Options:
  --port <name>      the serial port the radio is on (RT-4D, C62); see "ports"
  --out <folder>     where "backup" and "fetch" save (default: this folder)
  --again            back up a radio that already has a backup in --out
  --yes              do not ask before writing
  --experimental     go on with a radio nobody has checked this tool on
  --repo <owner/repo>  where firmware comes from (default OpenRTX/OpenRTX)
  --cskburn <file>   use this cskburn for the C62 instead of the pinned download
  --sim[=<how>]      simulated radio, no hardware: fail, protected, wrongmode or slow
  --help, --version

Listing and release files need no login. GitHub only gives CI builds to logged-in
users: without GITHUB_TOKEN they are downloaded through nightly.link instead.`;

/** A mistake in the command line; the message is for the person who typed it. */
export class UsageError extends Error {}

/** What to do. */
export type Command =
  | { name: 'help' | 'version' | 'firmware' | 'ports' }
  | { name: 'radios'; radio?: string }
  | { name: 'backup'; radio: string }
  | { name: 'fetch' | 'flash'; radio: string; firmware: string };

/** The options every command shares. */
export interface Options {
  /** The `?sim=` mode of the page; undefined for real hardware. */
  sim?: string;
  port?: string;
  out: string;
  repo?: string;
  cskburn?: string;
  yes: boolean;
  experimental: boolean;
  again: boolean;
}

/** A parsed command line. */
export interface Parsed {
  command: Command;
  options: Options;
}

/** How many words each command takes after its name: [fewest, most]. */
const WORDS: Record<string, [number, number]> = {
  radios: [0, 1],
  firmware: [0, 0],
  ports: [0, 0],
  backup: [1, 1],
  fetch: [2, 2],
  flash: [2, 2],
};

/** Parses `argv` (without node and the script). Throws UsageError on anything it does not understand. */
export function parse(argv: string[]): Parsed {
  let values;
  let words;
  try {
    ({ values, positionals: words } = parseArgs({
      // A bare --sim is the page's ?sim=1.
      args: argv.map((arg) => (arg === '--sim' ? '--sim=1' : arg)),
      allowPositionals: true,
      options: {
        sim: { type: 'string' },
        port: { type: 'string' },
        out: { type: 'string', default: '.' },
        repo: { type: 'string' },
        cskburn: { type: 'string' },
        yes: { type: 'boolean', short: 'y', default: false },
        experimental: { type: 'boolean', default: false },
        again: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', default: false },
      },
    }));
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message.split('. ')[0] : String(e));
  }
  const { help, version, ...options } = values;
  const [name, ...rest] = words;
  if (help || name === 'help' || (name === undefined && !version))
    return { command: { name: 'help' }, options };
  if (version) return { command: { name: 'version' }, options };

  // Its own entries only: "toString" and "constructor" are in every object, and are no commands.
  if (!Object.hasOwn(WORDS, name)) throw new UsageError(`There is no "${name}" command.`);
  const takes = WORDS[name];
  if (rest.length < takes[0]) {
    throw new UsageError(
      name === 'backup' ? '"backup" needs a radio.' : `"${name}" needs a radio and a firmware.`,
    );
  }
  if (rest.length > takes[1]) throw new UsageError(`"${name}" does not take "${rest[takes[1]]}".`);
  const [radio, firmware] = rest;
  switch (name) {
    case 'radios':
      return { command: { name, radio }, options };
    case 'backup':
      return { command: { name, radio }, options };
    case 'fetch':
    case 'flash':
      return { command: { name, radio, firmware }, options };
    default:
      return { command: { name: name as 'firmware' | 'ports' }, options };
  }
}
