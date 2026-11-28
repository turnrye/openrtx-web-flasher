// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Small shared pieces of the page. The look comes from daisyUI components and Tailwind
 * utilities (site/styles/theme.css holds the theme); nothing here has a stylesheet of
 * its own.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { Progress } from '../flash/types.ts';

/** "237 KB" or "1.2 MB". */
export function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/** "4 Oct 2026" in the reader's locale; empty for a missing date. */
export function formatDate(iso?: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** "4 Oct 2026, 10:23" in the reader's locale and time zone; empty for a missing date. */
export function formatDateTime(iso?: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** A link that leaves the page: always a new tab, so a read or a write is never navigated away from. */
export function Out(props: { href: string; children: ComponentChildren; testid?: string; class?: string }) {
  return (
    <a
      class={props.class ?? 'link link-primary'}
      href={props.href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid={props.testid}
    >
      {props.children}
    </a>
  );
}

/** What a notice is about; decides its colour. */
export type Tone = 'info' | 'success' | 'warning' | 'error';

const TONE_CLASS: Record<Tone, string> = {
  info: 'alert-info',
  success: 'alert-success',
  warning: 'alert-warning',
  error: 'alert-error',
};

/** A framed message in a status colour: the frame carries the colour, the text stays white. */
export function Notice(props: {
  tone: Tone;
  children: ComponentChildren;
  testid?: string;
  /** "alert" for something that went wrong just now, "status" for news; left out for standing text. */
  role?: 'alert' | 'status';
}) {
  return (
    <div
      class={`alert alert-outline ${TONE_CLASS[props.tone]} block text-start text-base-content`}
      role={props.role}
      data-testid={props.testid}
    >
      {props.children}
    </div>
  );
}

/** How long a step takes to fold or open: daisyUI's collapse transition. */
const STEP_MS = 200;

/**
 * How a step shows: `waiting` until the steps before it are done (only its bar, greyed),
 * `folded` when it can be opened (its bar is a button), `open` with its content.
 */
export type StepMode = 'waiting' | 'folded' | 'open';

/**
 * One numbered step of the page: a title bar, then its content while the step is open.
 * A daisyUI collapse driven by `mode`: folded content stays in the page, hidden and out
 * of reach of the keyboard, and the fold is animated unless the reader asked for less
 * motion.
 */
export function Step(props: {
  /** Step number; left out for sections that are not a step. */
  num?: number;
  title: string;
  /** Shown at the right of the bar, e.g. the current choice. */
  state?: string;
  /** A second line under a folded bar, for facts and links that do not fit in a button. */
  detail?: ComponentChildren;
  mode: StepMode;
  /** Opens a folded step. */
  onOpen?: () => void;
  /** What opening a folded step is called on its bar: "open", or "change" for a choice. */
  hint?: string;
  id: string;
  children: ComponentChildren;
}) {
  const { mode, id } = props;
  const clickable = mode === 'folded' && !!props.onOpen;
  const section = useRef<HTMLElement>(null);
  // A step is brought into view only once it has changed since the page loaded: the step
  // that is open at the start is simply there.
  const last = useRef(mode);
  const moved = useRef(false);
  if (last.current !== mode) {
    last.current = mode;
    moved.current = true;
  }

  // Bring a step that just opened into view once the one before it has folded away.
  useEffect(() => {
    const element = section.current;
    if (mode !== 'open' || !moved.current || !element) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timer = setTimeout(
      () => {
        const box = element.getBoundingClientRect();
        if (box.top >= 0 && box.bottom <= window.innerHeight) return;
        element.scrollIntoView({
          behavior: still ? 'auto' : 'smooth',
          block: box.height <= window.innerHeight ? 'nearest' : 'start',
        });
      },
      still ? 0 : STEP_MS,
    );
    return () => clearTimeout(timer);
  }, [mode]);

  // The number: gold while the step is open, a green tick once it shows a result, an
  // outline while it waits.
  const finished = mode === 'folded' && !!props.state;
  const marker =
    mode === 'open'
      ? 'bg-primary text-primary-content'
      : finished
        ? 'bg-success text-success-content'
        : 'border border-base-300 text-base-content/70';
  const titleClass = `text-lg font-medium flex-1 sm:flex-none ${mode === 'waiting' ? 'text-base-content/60' : ''}`;
  const bar = (
    <>
      {props.num !== undefined && (
        <span
          class={`grid size-7 flex-none place-items-center rounded-full text-sm font-medium ${marker}`}
          aria-hidden={finished}
        >
          {finished ? '✓' : props.num}
        </span>
      )}
      {clickable ? (
        <span class={titleClass} id={`${id}-title`}>
          {props.title}
        </span>
      ) : (
        <h2 class={titleClass} id={`${id}-title`}>
          {props.title}
        </h2>
      )}
      {/* On a narrow screen the state gets a line of its own, so the bar never collides. */}
      <span
        class="order-last min-w-0 basis-full text-sm text-base-content/80 max-sm:ps-10 sm:order-none sm:flex-1 sm:basis-0 sm:truncate sm:text-end"
        data-testid="step-state"
      >
        {props.state}
      </span>
      {clickable && (
        <span class="flex-none text-sm font-medium text-primary">
          <span class="font-normal text-base-content/60 max-sm:hidden">{props.state ? ' · ' : ''}</span>
          {props.hint ?? 'open'}
        </span>
      )}
    </>
  );
  const barClass = 'flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-start';
  return (
    <section
      ref={section}
      class={`collapse border bg-base-100 ${mode === 'open' ? 'collapse-open border-base-300' : 'collapse-close border-separator'}`}
      id={id}
      aria-labelledby={`${id}-title`}
      data-mode={mode}
      data-testid="step"
    >
      <div class="col-start-1 row-start-1 rounded-t-box bg-base-200">
        {clickable ? (
          <button
            class={`${barClass} cursor-pointer rounded-box motion-safe:transition-colors hover:bg-base-300`}
            type="button"
            aria-expanded="false"
            data-testid={`open-${id}`}
            onClick={props.onOpen}
          >
            {bar}
          </button>
        ) : (
          <header class={barClass}>{bar}</header>
        )}
        {mode === 'folded' && props.detail && (
          <div class="-mt-1 ps-14 pe-4 pb-3 text-sm text-base-content/80" data-testid="step-detail">
            {props.detail}
          </div>
        )}
      </div>
      {/* Kept in the page while folded, so a step does not lose what it was showing. The
          padding sits on the inner box: the collapsing one must be able to shrink to nothing. */}
      {mode !== 'waiting' && (
        <div class="collapse-content p-0" data-testid="step-body">
          <div class="flex flex-col gap-4 p-4 sm:p-5">{props.children}</div>
        </div>
      )}
    </section>
  );
}

const PHASE_LABEL: Record<Progress['phase'], string> = {
  connect: 'LINK',
  read: 'READ',
  erase: 'ERASE',
  write: 'WRITE',
  verify: 'CHECK',
  done: 'DONE',
};

/** Progress bar with the phase in the radio's own short words. */
export function Meter(props: {
  progress: Progress;
  failed?: boolean;
  /** True while the radio is busy: the bar shows movement even before the first progress. */
  active?: boolean;
}) {
  const { progress, failed, active } = props;
  const exact = progress.total > 0 ? Math.min(100, (progress.done / progress.total) * 100) : 0;
  const percent = Math.round(exact);
  // A slow read spends a long time below 10%: show tenths there so the number moves.
  const shown = active && exact > 0 && exact < 10 ? exact.toFixed(1) : String(percent);
  const waiting = !!active && exact === 0;
  return (
    <div
      class="flex items-center gap-3 font-mono text-sm"
      data-testid="meter"
      data-state={failed ? 'failed' : active ? 'active' : 'still'}
    >
      <span class={`w-12 flex-none font-medium ${failed ? 'text-error' : 'text-success'}`}>
        {failed ? 'FAIL' : PHASE_LABEL[progress.phase]}
      </span>
      {/* Without a value the bar runs back and forth: busy, with nothing to count yet. */}
      <progress
        class={`progress h-3 flex-1 ${failed ? 'progress-error' : 'progress-success'}`}
        value={waiting ? undefined : exact}
        max={100}
        aria-label="Progress"
      />
      <span
        class="w-14 flex-none text-end font-readout text-xl leading-none tabular-nums"
        data-testid="percent"
      >
        {shown}%
      </span>
    </div>
  );
}

/** A box files can be dropped on, with a button for people who prefer a file dialog. */
export function DropZone(props: {
  onFile: (file: File) => void;
  children: ComponentChildren;
  accept?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  /** Marks the box while a file is held over it. */
  const mark = (box: EventTarget | null, over: boolean) =>
    (box as HTMLElement | null)?.toggleAttribute('data-over', over);
  return (
    <div
      class="flex flex-col items-center gap-3 rounded-box border-2 border-dashed border-base-300 p-6 text-center data-over:border-primary data-over:bg-base-200"
      data-testid="dropzone"
      onDragOver={(e) => {
        e.preventDefault();
        mark(e.currentTarget, true);
      }}
      onDragLeave={(e) => mark(e.currentTarget, false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        mark(e.currentTarget, false);
        const file = e.dataTransfer?.files[0];
        if (file) props.onFile(file);
      }}
    >
      <div>{props.children}</div>
      {/* A button, not a label around the input: a hidden input takes no keyboard focus. */}
      <button class="btn" type="button" data-testid="choose-file" onClick={() => input.current?.click()}>
        Choose a file
      </button>
      <input
        ref={input}
        type="file"
        hidden
        accept={props.accept}
        data-testid="file-input"
        onChange={(e) => {
          const picked = e.currentTarget;
          const file = picked.files?.[0];
          if (file) props.onFile(file);
          picked.value = '';
        }}
      />
    </div>
  );
}
