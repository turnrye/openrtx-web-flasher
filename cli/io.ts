// SPDX-License-Identifier: GPL-3.0-or-later
/** How the command line talks to the person at the terminal: lines, one progress line, questions. */
import { createInterface } from 'node:readline/promises';
import type { Progress } from '../src/flash/types.ts';

/** The terminal, or a stand-in for it in tests. */
export interface Io {
  /** True when a person can be asked: input and output are both a terminal. */
  readonly interactive: boolean;
  /** Prints one line. */
  say(line?: string): void;
  /** Shows how far a read or a write got; redrawn in place on a terminal. */
  progress(p: Progress): void;
  /** Asks a yes/no question; anything but "y" or "yes" is no. */
  confirm(question: string): Promise<boolean>;
  /** Asks which of `options`; null when the person picked none. */
  choose(question: string, options: string[]): Promise<number | null>;
}

/** "237 KB" or "1.2 MB", as the page writes sizes. */
export function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

const PHASE_TEXT: Record<Progress['phase'], string> = {
  connect: 'Connecting to the radio',
  read: 'Reading',
  erase: 'Erasing',
  write: 'Writing',
  verify: 'Checking what was written',
  done: 'Done',
};

/** Percent of a progress report, 0 to 100. */
function percent(p: Progress): number {
  return p.total > 0 ? Math.min(100, Math.floor((p.done / p.total) * 100)) : 0;
}

/** One progress report as text: "Writing 120 KB of 300 KB (40%)". */
export function progressText(p: Progress): string {
  if (p.phase === 'connect' || p.phase === 'done') return PHASE_TEXT[p.phase];
  const amounts = p.phase === 'erase' ? '' : ` ${formatSize(p.done)} of ${formatSize(p.total)}`;
  return `${PHASE_TEXT[p.phase]}${amounts} (${percent(p)}%)`;
}

/** The streams `terminalIo` needs; process.stdin and process.stdout fit. */
export interface Streams {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream & { isTTY?: boolean };
}

/** An Io on real streams. Without a terminal it asks nothing and prints progress as plain lines. */
export function terminalIo({ input, output }: Streams): Io {
  const tty = output.isTTY === true;
  /** The progress line on screen, to be wiped before the next ordinary line. */
  let drawn = false;
  /** The step the last progress line was for, so the same one is not printed twice. */
  let last = '';
  let lastDrawn = 0;

  /** Removes the progress line from a terminal. */
  const wipe = () => {
    if (drawn) output.write('\r\x1b[K');
    drawn = false;
  };

  /** Asks one question and returns the answer, trimmed. */
  const ask = async (question: string): Promise<string> => {
    wipe();
    const rl = createInterface({ input, output });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  };

  const interactive = tty && input.isTTY === true;
  return {
    interactive,
    say(line = '') {
      wipe();
      output.write(`${line}\n`);
    },
    progress(p) {
      if (tty) {
        // A flasher reports thousands of times; a terminal needs a few a second.
        const now = Date.now();
        if (p.phase === last && p.done < p.total && now - lastDrawn < 100) return;
        output.write(`\r\x1b[K${progressText(p)}`);
        drawn = true;
        last = p.phase;
        lastDrawn = now;
        return;
      }
      // In a file or a pipe: one line per phase and per tenth.
      const step = `${p.phase} ${Math.floor(percent(p) / 10)}`;
      if (step === last || p.phase === 'connect' || p.phase === 'done') return;
      last = step;
      output.write(`${progressText(p)}\n`);
    },
    async confirm(question) {
      if (!interactive) return false;
      return /^y(es)?$/i.test(await ask(`${question} [y/N] `));
    },
    async choose(question, options) {
      if (!interactive) return null;
      wipe();
      options.forEach((option, i) => output.write(`  ${i + 1}  ${option}\n`));
      const picked = Number(await ask(`${question} [1-${options.length}] `));
      return Number.isInteger(picked) && picked >= 1 && picked <= options.length ? picked - 1 : null;
    },
  };
}
