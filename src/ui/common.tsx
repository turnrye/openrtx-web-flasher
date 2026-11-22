// SPDX-License-Identifier: GPL-3.0-or-later
/** Small shared pieces of the page. */
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

/** How long a step takes to fold or open; the same value as --step-time in the stylesheet. */
const STEP_MS = 240;

/**
 * How a step shows: `waiting` until the steps before it are done (only its bar, greyed),
 * `folded` when it can be opened (its bar is a button), `open` with its content.
 */
export type StepMode = 'waiting' | 'folded' | 'open';

/** One numbered step of the page: a title bar, then its content while the step is open. */
export function Step(props: {
  /** Step number; left out for sections that are not a step. */
  num?: number;
  title: string;
  /** Shown at the right of the bar, e.g. the current choice. */
  state?: string;
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
  // A step animates open only once it has changed since the page loaded: the step that
  // is open at the start is simply there.
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

  const bar = (
    <>
      <span class="num">{props.num ?? ''}</span>
      {clickable ? (
        <span class="title" id={`${id}-title`}>
          {props.title}
        </span>
      ) : (
        <h2 class="title" id={`${id}-title`}>
          {props.title}
        </h2>
      )}
      <span class="state">
        {props.state}
        {clickable && (
          <span class="hint">
            {props.state ? ' · ' : ''}
            {props.hint ?? 'open'}
          </span>
        )}
      </span>
    </>
  );
  return (
    <section
      ref={section}
      class={`step ${mode}${moved.current ? ' moved' : ''}`}
      id={id}
      aria-labelledby={`${id}-title`}
      data-mode={mode}
    >
      {clickable ? (
        <button
          class="bar"
          type="button"
          aria-expanded="false"
          data-testid={`open-${id}`}
          onClick={props.onOpen}
        >
          {bar}
        </button>
      ) : (
        <header class="bar">{bar}</header>
      )}
      {/* Kept in the page while folded, so a step does not lose what it was showing; the
          stylesheet folds it away and takes it out of reach. */}
      {mode !== 'waiting' && (
        <div class="step-body">
          <div class="step-inner">{props.children}</div>
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

/** Progress bar drawn like the radio's signal meter. */
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
  const state = `${failed ? ' error' : ''}${active ? ' active' : ''}${active && exact === 0 ? ' waiting' : ''}`;
  return (
    <div class={`meter${state}`} data-testid="meter">
      <span class="phase">{failed ? 'FAIL' : PHASE_LABEL[progress.phase]}</span>
      <div
        class="track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label="Flashing progress"
      >
        <div class="fill" style={{ width: `${exact}%` }} />
      </div>
      <span data-testid="percent">{shown}%</span>
      <div class="ticks" aria-hidden="true">
        {[0, 25, 50, 75, 100].map((t) => (
          <span key={t}>{t}</span>
        ))}
      </div>
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
  return (
    <div
      class="dropzone"
      data-testid="dropzone"
      onDragOver={(e) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement).classList.add('over');
      }}
      onDragLeave={(e) => (e.currentTarget as HTMLElement).classList.remove('over')}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        (e.currentTarget as HTMLElement).classList.remove('over');
        const file = e.dataTransfer?.files[0];
        if (file) props.onFile(file);
      }}
    >
      <div>{props.children}</div>
      {/* A button, not a label around the input: a hidden input takes no keyboard focus. */}
      <button
        class="btn"
        type="button"
        style={{ marginTop: '10px' }}
        data-testid="choose-file"
        onClick={() => input.current?.click()}
      >
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
