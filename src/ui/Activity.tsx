// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What the page shows while it talks to a radio: the meter, a line that says what is
 * happening and for how long, the last thing the radio said, and a console that fills
 * in as it goes. A slow link (a C62 is read at about 7 KB a second) must still look
 * alive, so the line carries amounts and a clock, not only a percentage.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Progress } from '../flash/types.ts';
import { formatSize, Meter } from './common.tsx';

const PHASE_TEXT: Record<Progress['phase'], string> = {
  connect: 'Connecting to the radio',
  read: 'Reading',
  erase: 'Erasing',
  write: 'Writing',
  verify: 'Checking what was written',
  done: 'Done',
};

/** Phases whose progress counts bytes. */
const COUNTS_BYTES: Progress['phase'][] = ['read', 'write', 'verify'];

/** "0:07" or "12:40". */
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * How long the rest of a phase will take, from how far it got in `elapsedMs`. Empty until
 * there is enough to go on: a few seconds and some progress.
 */
export function remaining(done: number, total: number, elapsedMs: number): string {
  if (elapsedMs < 4000 || done <= 0 || done >= total) return '';
  const seconds = (elapsedMs / 1000) * ((total - done) / done);
  if (seconds < 50) return 'under a minute left';
  if (seconds < 90) return 'about a minute left';
  return `about ${Math.round(seconds / 60)} min left`;
}

/** The line that says what is happening: the phase, how much, for how long, how much longer. */
export function describe(
  progress: Progress,
  elapsedMs: number,
  phaseMs: number,
  phaseStartDone: number,
): string {
  const parts = [PHASE_TEXT[progress.phase]];
  if (COUNTS_BYTES.includes(progress.phase) && progress.total > 1) {
    parts.push(`${formatSize(progress.done)} of ${formatSize(progress.total)}`);
  }
  parts.push(`${clock(elapsedMs)} elapsed`);
  const left = remaining(progress.done - phaseStartDone, progress.total - phaseStartDone, phaseMs);
  if (left) parts.push(left);
  return parts.join(' · ');
}

/**
 * Decides which progress reports are worth drawing: a new phase, the end, and otherwise
 * one about every `intervalMs`. Flashers report far more often than a screen needs.
 */
export function paintGate(intervalMs = 150): (progress: Progress) => boolean {
  let phase = '';
  let at = 0;
  return (progress) => {
    const now = performance.now();
    if (progress.phase !== phase || progress.done >= progress.total || now - at >= intervalMs) {
      phase = progress.phase;
      at = now;
      return true;
    }
    return false;
  };
}

/** The lines the flasher or reader logged, in a box that opens on demand and follows the end. */
export function Console({ lines, running }: { lines: string[]; running: boolean }) {
  const pre = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const element = pre.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines.length]);
  if (lines.length === 0 && !running) return null;
  return (
    <details class="log" data-testid="console">
      <summary>
        Console
        {lines.length > 0 && ` (${lines.length} ${lines.length === 1 ? 'line' : 'lines'})`}
      </summary>
      <pre ref={pre} data-testid="log">
        {lines.length > 0 ? lines.join('\n') : 'Nothing yet.'}
      </pre>
    </details>
  );
}

interface Props {
  progress: Progress;
  /** True while the radio is being read or written. */
  running: boolean;
  failed?: boolean;
  /** What was logged so far, oldest line first. */
  log: string[];
  /** When this attempt started, from Date.now(). */
  startedAt: number;
}

/** Meter, status line, last message and console for one read or write of the radio. */
export function Activity({ progress, running, failed, log, startedAt }: Props) {
  const [now, setNow] = useState(() => Date.now());
  // When the current phase began and how far along it already was, for the time estimate.
  const phase = useRef({ name: progress.phase, at: startedAt, done: progress.done });
  if (phase.current.name !== progress.phase) {
    phase.current = { name: progress.phase, at: Date.now(), done: progress.done };
  }

  // The clock keeps moving while the radio is quiet.
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const last = log.at(-1);
  return (
    <div class="activity">
      <Meter progress={progress} failed={failed} active={running} />
      {running && (
        <>
          <p class="activity-now" role="status" data-testid="activity">
            {describe(progress, now - startedAt, now - phase.current.at, phase.current.done)}
          </p>
          {last && (
            <p class="muted small activity-last" data-testid="activity-last">
              {last}
            </p>
          )}
        </>
      )}
      <Console lines={log} running={running} />
    </div>
  );
}
