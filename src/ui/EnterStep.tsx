// SPDX-License-Identifier: GPL-3.0-or-later
/** The step that puts the radio in flashing mode: a drawing with the keys to hold, and what to do. */
import type { Radio } from '../radios.ts';
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
    <div class="block" data-testid="enter-step">
      <UseInstead radio={radio} />
      {again && (
        <p data-testid="enter-again">Reading the radio ended flashing mode. Put the radio in it again.</p>
      )}
      <div class="enter">
        <RadioArt id={radio.id} enter />
        <div>
          <ol data-testid="enter-steps">
            {radio.enter.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          {radio.heldKeysDrawn && <p class="gold small">The keys to hold are shown in gold.</p>}
          {radio.enterUnconfirmed && (
            <p class="muted small">
              OpenRTX’s documentation does not give the key combination for this radio yet; this is the usual
              one. If the radio starts in normal mode, check its manual.
            </p>
          )}
          <div class="actions">
            <button class="btn primary" type="button" data-testid="entered" onClick={onDone}>
              It is in flashing mode
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
