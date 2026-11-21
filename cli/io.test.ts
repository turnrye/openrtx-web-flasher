// SPDX-License-Identifier: GPL-3.0-or-later
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { formatSize, progressText, terminalIo } from './io.ts';

/** An Io on streams the test can read and feed; `tty` makes both look like a terminal. */
function io(tty: boolean) {
  const input = Object.assign(new PassThrough(), { isTTY: tty });
  const output = Object.assign(new PassThrough(), { isTTY: tty });
  let written = '';
  output.on('data', (chunk: Buffer) => (written += chunk.toString()));
  return { io: terminalIo({ input, output }), input, written: () => written };
}

describe('what the terminal shows', () => {
  it('writes sizes as the page does', () => {
    expect(formatSize(300 * 1024)).toBe('300 KB');
    expect(formatSize(4 * 1024 * 1024)).toBe('4.0 MB');
  });

  it('says how far a read or a write got', () => {
    expect(progressText({ phase: 'connect', done: 0, total: 10 })).toBe('Connecting to the radio');
    expect(progressText({ phase: 'write', done: 120 * 1024, total: 300 * 1024 })).toBe(
      'Writing 120 KB of 300 KB (40%)',
    );
    expect(progressText({ phase: 'erase', done: 1, total: 2 })).toBe('Erasing (50%)');
    expect(progressText({ phase: 'read', done: 0, total: 0 })).toBe('Reading 0 KB of 0 KB (0%)');
  });

  it('prints progress as a few plain lines when the output is not a terminal', () => {
    const t = io(false);
    for (let done = 0; done <= 1000; done++) t.io.progress({ phase: 'write', done, total: 1000 });
    t.io.say('after');
    const lines = t.written().trim().split('\n');
    expect(lines.length).toBe(12);
    expect(lines[1]).toBe('Writing 0 KB of 1 KB (10%)');
    expect(lines[11]).toBe('after');
    expect(t.written()).not.toContain('\r');
  });

  it('redraws one line on a terminal and wipes it before the next line', () => {
    const t = io(true);
    t.io.progress({ phase: 'write', done: 0, total: 1000 });
    t.io.progress({ phase: 'write', done: 1, total: 1000 });
    t.io.progress({ phase: 'write', done: 1000, total: 1000 });
    t.io.say('Done.');
    expect(t.written()).toBe(
      '\r\x1b[KWriting 0 KB of 1 KB (0%)\r\x1b[KWriting 1 KB of 1 KB (100%)\r\x1b[KDone.\n',
    );
  });

  it('asks nothing and takes no for an answer when nobody is there', async () => {
    const t = io(false);
    expect(t.io.interactive).toBe(false);
    expect(await t.io.confirm('Write?')).toBe(false);
    expect(await t.io.choose('Which?', ['a', 'b'])).toBeNull();
    expect(t.written()).toBe('');
  });

  it('takes only y or yes for a yes', async () => {
    for (const [typed, expected] of [
      ['y', true],
      ['YES', true],
      ['', false],
      ['n', false],
      ['yep', false],
    ] as const) {
      const t = io(true);
      const answer = t.io.confirm('Write it?');
      t.input.write(`${typed}\n`);
      expect(await answer, typed).toBe(expected);
      expect(t.written()).toContain('Write it? [y/N] ');
    }
  });

  it('lets the person pick from a list by number', async () => {
    const t = io(true);
    const picked = t.io.choose('Which port?', ['/dev/a', '/dev/b']);
    t.input.write('2\n');
    expect(await picked).toBe(1);
    expect(t.written()).toContain('  2  /dev/b\n');

    const none = io(true);
    const refused = none.io.choose('Which port?', ['/dev/a']);
    none.input.write('5\n');
    expect(await refused).toBeNull();
  });
});
