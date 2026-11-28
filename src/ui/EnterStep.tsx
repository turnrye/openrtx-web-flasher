// SPDX-License-Identifier: GPL-3.0-or-later
/** The step that puts the radio in flashing mode: a drawing with the keys to hold, and what to do. */
import type { Radio } from '../radios.ts';
import { Notice } from './common.tsx';
import { RadioArt } from './RadioArt.tsx';
import { UseInstead } from './UseInstead.tsx';

interface Props {
  radio: Radio;
  /** True when reading the radio just ended flashing mode, so this is the second time. */
  again: boolean;
  /** The user says the radio is in flashing mode. */
  onDone: () => void;
}

/** How to enter flashing mode, and a button to say it is done. */
export function EnterStep({ radio, again, onDone }: Props) {
  return (
    <div class="flex flex-col gap-4" data-testid="enter-step">
      <UseInstead radio={radio} />
      {again && (
        <Notice tone="info" testid="enter-again">
          Reading the radio ended flashing mode. Put the radio in it again.
        </Notice>
      )}
      <div class="flex flex-col items-center gap-5 sm:flex-row sm:items-start sm:gap-8">
        <RadioArt id={radio.id} enter class="h-64 w-40 flex-none" />
        <div class="flex min-w-0 flex-col gap-3">
          <ol
            class="flex list-decimal flex-col gap-2 ps-5 marker:font-medium marker:text-primary"
            data-testid="enter-steps"
          >
            {radio.enter.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          {radio.heldKeysDrawn && <p class="text-sm text-primary">The keys to hold are shown in gold.</p>}
          {radio.enterUnconfirmed && (
            <p class="text-sm text-muted">
              OpenRTX’s documentation does not give the key combination for this radio yet; this is the usual
              one. If the radio starts in normal mode, check its manual.
            </p>
          )}
          <div class="mt-1">
            <button class="btn btn-primary" type="button" data-testid="entered" onClick={onDone}>
              It is in flashing mode
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
