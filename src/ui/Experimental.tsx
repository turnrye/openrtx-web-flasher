// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The one confirmation before the page writes to a radio model nobody has checked on
 * hardware yet. It sits in the flash step, the only step that changes the radio (reading
 * a radio for a backup changes nothing, so backups are not held back), and is remembered
 * for every radio.
 */
import type { Radio } from '../radios.ts';
import { Notice, Out } from './common.tsx';

/** Asks the user to turn experimental flashing on, and says what gets the radio back. */
export function ExperimentalGate({ radio, onTurnOn }: { radio: Radio; onTurnOn: () => void }) {
  return (
    <Notice tone="warning" testid="needs-experimental">
      <div class="flex flex-col gap-3">
        <p class="font-medium">Flashing the {radio.name} from this page is not checked yet.</p>
        <p>
          Nobody has confirmed a flash from this page on a real {radio.name}. If a flash goes wrong, the radio
          can be left without working firmware until it is flashed again, from this page or with{' '}
          <Out href={radio.manual.url} testid="recovery-tool">
            {radio.manual.tool}
          </Out>
          , the tool that recovers it.
        </p>
        <p>If this is the first radio you flash, you may prefer to wait until this model is checked.</p>
        <div>
          <button
            class="btn h-auto min-h-(--size) py-2"
            type="button"
            data-testid="turn-on-experimental"
            onClick={onTurnOn}
          >
            I can recover my radio: turn on experimental flashing
          </button>
        </div>
      </div>
    </Notice>
  );
}
