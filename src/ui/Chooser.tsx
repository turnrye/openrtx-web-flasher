// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The browser's own device list, which the page can neither style nor explain from the
 * inside: a line before each button that opens it says a list is coming and which entry
 * to pick, and a checklist appears when the list was closed without a pick.
 */
import type { Purpose } from '../flash/run.ts';
import { apiFor, backupFor, type Radio } from '../radios.ts';
import { Out } from './common.tsx';

/** True when the radio is asked for in normal mode: a backup read through its original firmware. */
function inNormalMode(radio: Radio, purpose: Purpose): boolean {
  const backup = backupFor(radio);
  return purpose === 'backup' && backup.how === 'read' && backup.mode === 'normal';
}

/** Which entry of the browser's list is the radio, as far as the page can say. */
function entry(radio: Radio): string {
  switch (apiFor(radio.method)) {
    case 'serial':
      return 'Pick the serial port of the programming cable: the entry that goes away when you unplug the cable.';
    case 'hid':
      return 'Pick the radio: it is usually the only entry, and may be listed without a name.';
    default:
      return radio.method === 'tyt-dfu'
        ? 'Pick the radio: it is usually the only entry, listed as “Digital Radio in USB mode”.'
        : 'Pick the radio: it is usually the only entry, listed as “STM32 BOOTLOADER”.';
  }
}

/** The line before a button that opens the browser's device list. */
export function ChooserHint({ radio }: { radio: Radio }) {
  return (
    <p class="text-sm text-base-content/80" data-testid="chooser-hint">
      Your browser will show a list of devices. {entry(radio)}
    </p>
  );
}

/** What to check when the radio does not show up or does not answer, as a list. */
export function Checks({ radio, purpose }: { radio: Radio; purpose: Purpose }) {
  const api = apiFor(radio.method);
  const normal = inNormalMode(radio, purpose);
  return (
    <ul class="flex list-disc flex-col gap-1 ps-5 text-sm" data-testid="checks">
      <li>The cable carries data and is pushed in all the way. Some USB cables only charge.</li>
      <li>
        {normal
          ? 'The radio is switched on in normal mode, without any key held.'
          : 'The radio is in flashing mode. If you are not sure, switch it off and do the flashing mode step again.'}
      </li>
      {normal && (
        <li>
          The radio still runs its original firmware. One that already runs OpenRTX cannot be read: answer
          “OpenRTX already” above.
        </li>
      )}
      {api === 'usb' && (
        <li>
          On Windows, the radio needs the WinUSB driver before the browser can see it. Install it once with{' '}
          <Out href="https://zadig.akeo.ie" testid="zadig">
            Zadig
          </Out>{' '}
          while the radio is connected in this mode.
        </li>
      )}
      <li>
        {api === 'serial'
          ? 'On Linux, your user needs permission for serial ports: usually membership of the dialout group.'
          : 'On Linux, your user needs permission for the device: a udev rule that lets you open it.'}
      </li>
      <li>No other program has the radio open: programming software, or another tab of this page.</li>
    </ul>
  );
}

/** Shown after the browser's list was closed without a pick: until now that was silent. */
export function ChooserHelp({ radio, purpose }: { radio: Radio; purpose: Purpose }) {
  return (
    <div
      class="flex flex-col gap-2 rounded-box border border-base-300 p-4"
      role="status"
      data-testid="chooser-help"
    >
      <h3 class="font-medium">Radio not in the list?</h3>
      <Checks radio={radio} purpose={purpose} />
      <p class="text-sm text-base-content/80">Then press the button again.</p>
    </div>
  );
}
