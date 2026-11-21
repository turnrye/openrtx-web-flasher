// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The one confirmation before the page talks to a radio model nobody has checked on
 * hardware yet. It sits in the step that would talk to the radio first, and is
 * remembered for every radio.
 */
import type { Radio } from '../radios.ts';

/** Asks the user to turn experimental flashing on. */
export function ExperimentalGate({ radio, onTurnOn }: { radio: Radio; onTurnOn: () => void }) {
  return (
    <div data-testid="needs-experimental">
      <p>
        Nobody has checked this page against a real {radio.name} yet. A failed flash can leave the radio
        without working firmware until you flash it again with the usual tool.
      </p>
      <div class="actions">
        <button class="btn" type="button" data-testid="turn-on-experimental" onClick={onTurnOn}>
          I can recover my radio: turn on experimental flashing
        </button>
      </div>
    </div>
  );
}
