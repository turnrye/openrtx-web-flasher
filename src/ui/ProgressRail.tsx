// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Where the user is among the five steps. On a wide screen, a list beside the steps that
 * stays in view (daisyUI `steps`); on a narrow one, a single line above them. Steps that
 * are done can be opened again from here, as from their own bars.
 */

/** How far a step has got. */
export type RailStatus = 'done' | 'current' | 'upcoming';

/** One step as the rail shows it. */
export interface RailStep {
  /** The step's name in the page, e.g. "backup"; used in test ids. */
  id: string;
  title: string;
  status: RailStatus;
  /** Opens the step again; left out while the radio is being read or written. */
  onOpen?: () => void;
}

/** The rail: a line on narrow screens, a list beside the steps on wide ones. */
export function ProgressRail({ steps }: { steps: RailStep[] }) {
  const at = steps.findIndex((s) => s.status === 'current');
  const current = at >= 0 ? steps[at] : undefined;
  return (
    <>
      {current && (
        <p
          class="sticky top-[var(--sl-nav-height,4rem)] z-10 border-b border-separator bg-base-100/95 py-2 text-sm font-medium lg:hidden"
          data-testid="rail-compact"
        >
          Step {at + 1} of {steps.length} · {current.title}
        </p>
      )}
      <nav
        aria-label="Progress"
        class="flex-none self-start max-lg:hidden lg:sticky lg:top-[calc(var(--sl-nav-height,4rem)+1rem)] lg:w-48"
        data-testid="rail"
      >
        <ol class="steps steps-vertical">
          {steps.map((s, i) => (
            <li
              key={s.id}
              class={`step ${s.status === 'upcoming' ? '' : 'step-primary'}`}
              data-content={s.status === 'done' ? '✓' : String(i + 1)}
              data-testid={`rail-${s.id}`}
              data-status={s.status}
              aria-current={s.status === 'current' ? 'step' : undefined}
            >
              {s.status === 'done' ? (
                <button
                  type="button"
                  class="link text-start whitespace-nowrap link-hover"
                  disabled={!s.onOpen}
                  onClick={s.onOpen}
                >
                  {s.title}
                </button>
              ) : (
                <span
                  class={`whitespace-nowrap ${s.status === 'current' ? 'font-medium' : 'text-base-content/60'}`}
                >
                  {s.title}
                </span>
              )}
            </li>
          ))}
        </ol>
      </nav>
    </>
  );
}
