// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Step 1: the radios as cards, each with its drawing. Radios in the current OpenRTX
 * release come first; the rest fold away under "No release yet". Every card says what
 * the radio needs for M17. A row of makers and an "M17 without a mod" box narrow both
 * lists.
 */
import { useState } from 'preact/hooks';
import { m17Label, makersOf, type Maker, type Radio } from '../radios.ts';
import { Out } from './common.tsx';
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

/** What the picker shows: every maker or one, and every radio or only those with M17 as they come. */
interface Filter {
  /** The one maker shown; null for all of them. */
  maker: Maker | null;
  /** True to show only radios that do M17 without a hardware modification. */
  m17Ready: boolean;
}

/** Shows every radio. */
const NO_FILTER: Filter = { maker: null, m17Ready: false };

/** True when `radio` passes `filter`. */
function passes(radio: Radio, filter: Filter): boolean {
  return (
    (filter.maker === null || makersOf(radio).includes(filter.maker)) &&
    (!filter.m17Ready || radio.m17.need === 'built-in')
  );
}

/** One radio: its drawing, its names, and what it needs for M17. */
function RadioCard({ radio, pressed, onChoose }: { radio: Radio; pressed: boolean; onChoose: () => void }) {
  const m17 = m17Label(radio);
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
        class={`badge badge-sm mt-auto h-auto py-0.5 ${
          m17.tone === 'good'
            ? 'badge-success'
            : m17.tone === 'mod'
              ? 'badge-outline badge-warning'
              : 'badge-outline text-base-content/80'
        }`}
        data-testid="m17-badge"
        data-m17={radio.m17.need}
      >
        {m17.text}
      </span>
    </button>
  );
}

/** The makers as toggle buttons, "All" first, and the "M17 without a mod" box. */
function Filters({
  makers,
  filter,
  onFilter,
}: {
  makers: Maker[];
  filter: Filter;
  onFilter: (next: Filter) => void;
}) {
  /** One maker button; `maker` null is "All". */
  const chip = (maker: Maker | null) => {
    const pressed = filter.maker === maker;
    return (
      <button
        key={maker ?? 'all'}
        type="button"
        class={`btn btn-sm rounded-full ${pressed ? 'btn-primary' : 'btn-outline border-base-300 font-normal'}`}
        aria-pressed={pressed}
        data-testid={`maker-${maker === null ? 'all' : maker.toLowerCase().replace(/\s+/g, '-')}`}
        onClick={() => onFilter({ ...filter, maker })}
      >
        {maker ?? 'All'}
      </button>
    );
  };
  return (
    <div class="flex flex-wrap items-center gap-x-6 gap-y-3" data-testid="filters">
      <div class="flex flex-wrap gap-2" role="group" aria-label="Maker">
        {chip(null)}
        {makers.map(chip)}
      </div>
      <label class="label cursor-pointer gap-2 text-sm text-base-content">
        <input
          type="checkbox"
          class="checkbox checkbox-sm checkbox-success"
          checked={filter.m17Ready}
          data-testid="m17-ready"
          onChange={(e) => onFilter({ ...filter, m17Ready: e.currentTarget.checked })}
        />
        M17 without a hardware mod
      </label>
    </div>
  );
}

/** The filters, the grid of radios and the folded group of those without a release. */
export function RadioPicker({ released, unreleased, chosen, onChoose }: Props) {
  const [unreleasedOpen, setUnreleasedOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>(NO_FILTER);
  const makers = [...new Set([...released, ...unreleased].flatMap(makersOf))];
  const releasedShown = released.filter((r) => passes(r, filter));
  const unreleasedShown = unreleased.filter((r) => passes(r, filter));
  /** Applies a filter, and opens the folded group when it holds radios the filter keeps. */
  const applyFilter = (next: Filter) => {
    setFilter(next);
    const narrowed = next.maker !== null || next.m17Ready;
    if (narrowed && unreleased.some((r) => passes(r, next))) setUnreleasedOpen(true);
  };
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
    <div class="flex flex-col gap-4">
      <p class="text-sm text-base-content/80" data-testid="m17-legend">
        Every radio here runs OpenRTX. Some need a small hardware modification before they can use M17 digital
        voice; each card says which, from the <Out href={'https://openrtx.org/#/M17/m17'}>M17 page</Out>.
      </p>
      <Filters makers={makers} filter={filter} onFilter={applyFilter} />
      {releasedShown.length === 0 && unreleasedShown.length === 0 && (
        <p class="text-sm" data-testid="no-match">
          No radio matches.{' '}
          <button
            type="button"
            class="link link-primary"
            data-testid="show-all"
            onClick={() => setFilter(NO_FILTER)}
          >
            Show all radios
          </button>
        </p>
      )}
      <div class="flex flex-col gap-4" data-testid="radios">
        {releasedShown.length > 0 && <div class={grid}>{releasedShown.map(card)}</div>}
        {unreleasedShown.length > 0 && (
          <details
            class="collapse-arrow collapse border border-separator"
            data-testid="no-release"
            open={unreleasedOpen || (chosen !== null && unreleasedShown.includes(chosen))}
            onToggle={(e) => setUnreleasedOpen(e.currentTarget.open)}
          >
            <summary class="collapse-title min-h-0 py-3 font-medium">
              No release yet ({unreleasedShown.length})
            </summary>
            <div class="collapse-content flex flex-col gap-3">
              <p class="text-sm text-base-content/80">
                OpenRTX has not released firmware for these radios yet. They take a development build, or a
                file you bring.
              </p>
              <div class={grid}>{unreleasedShown.map(card)}</div>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
