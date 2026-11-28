// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Step 1: the radios as cards, each with its drawing. Radios in the current OpenRTX
 * release come first; the rest fold away under "No release yet". Every card says
 * whether flashing it from this page was checked on a real radio.
 */
import { useState } from 'preact/hooks';
import type { Radio } from '../radios.ts';
import { RadioArt } from './RadioArt.tsx';

interface Props {
  /** Radios with a file in the current release. */
  released: Radio[];
  /** The others: they take a development build or a file. */
  unreleased: Radio[];
  /** The radio that is chosen now. */
  chosen: Radio | null;
  onChoose: (radio: Radio) => void;
}

/** One radio: its drawing, its names, and whether flashing it from here was checked. */
function RadioCard({ radio, pressed, onChoose }: { radio: Radio; pressed: boolean; onChoose: () => void }) {
  return (
    <button
      type="button"
      class={`card card-border cursor-pointer items-center gap-1 px-2 pt-4 pb-3 text-center motion-safe:transition-colors ${
        pressed
          ? 'border-secondary bg-secondary/15 ring-1 ring-secondary'
          : 'border-base-300 bg-base-200/50 hover:bg-base-200'
      }`}
      aria-pressed={pressed}
      data-testid={`radio-${radio.id}`}
      onClick={onChoose}
    >
      <RadioArt id={radio.id} class="h-36 w-24 sm:h-40" />
      <span class="mt-2 leading-tight font-medium">{radio.name}</span>
      {radio.aka && <span class="text-sm leading-tight text-base-content/80">{radio.aka}</span>}
      {/* Pushed to the foot of the card, so the badges of a row line up. */}
      <span
        class={`badge badge-sm mt-auto ${radio.verified ? 'badge-success' : 'badge-outline text-base-content/80'}`}
        data-testid="checked-badge"
        data-checked={radio.verified ? 'yes' : 'no'}
      >
        {radio.verified ? 'Checked' : 'Not checked yet'}
      </span>
    </button>
  );
}

/** The grid of radios and the folded group of those without a release. */
export function RadioPicker({ released, unreleased, chosen, onChoose }: Props) {
  const [unreleasedOpen, setUnreleasedOpen] = useState(false);
  const grid = 'grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]';
  /** The card of one radio. */
  const card = (radio: Radio) => (
    <RadioCard
      key={radio.id}
      radio={radio}
      pressed={chosen?.id === radio.id}
      onChoose={() => onChoose(radio)}
    />
  );
  return (
    <div class="flex flex-col gap-4" data-testid="radios">
      <p class="text-sm text-base-content/80" data-testid="checked-legend">
        “Checked” means someone flashed that model from this page and it started OpenRTX. The others have not
        been confirmed on a real radio yet; the page asks before it flashes one.
      </p>
      <div class={grid}>{released.map(card)}</div>
      {unreleased.length > 0 && (
        <details
          class="collapse-arrow collapse border border-separator"
          data-testid="no-release"
          open={unreleasedOpen || (chosen !== null && unreleased.includes(chosen))}
          onToggle={(e) => setUnreleasedOpen(e.currentTarget.open)}
        >
          <summary class="collapse-title min-h-0 py-3 font-medium">
            No release yet ({unreleased.length})
          </summary>
          <div class="collapse-content flex flex-col gap-3">
            <p class="text-sm text-base-content/80">
              OpenRTX has not released firmware for these radios yet. They take a development build, or a file
              you bring.
            </p>
            <div class={grid}>{unreleased.map(card)}</div>
          </div>
        </details>
      )}
    </div>
  );
}
