// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What a first-timer should know before step 1: what is needed, what flashing changes,
 * what does not work yet, and how to go back. Someone who has read it folds it away,
 * and it stays folded in this browser.
 */
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { introFolded } from '../settings.ts';
import { Out } from './common.tsx';

/** One of the four short answers. */
function Point({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <div class="flex flex-col gap-1">
      <h3 class="font-medium text-primary">{title}</h3>
      <p class="text-sm">{children}</p>
    </div>
  );
}

/** The block above the steps. */
export function BeforeYouStart() {
  const [open, setOpen] = useState(() => !introFolded.get());
  return (
    <details
      class="collapse-arrow collapse border border-base-300 bg-base-200"
      data-testid="before-you-start"
      open={open}
      onToggle={(e) => {
        const now = e.currentTarget.open;
        setOpen(now);
        introFolded.set(!now);
      }}
    >
      <summary class="collapse-title min-h-0 py-3 text-lg font-medium">Before you start</summary>
      <div class="collapse-content grid gap-x-8 gap-y-4 sm:grid-cols-2">
        <Point title="What you need">
          Chrome or Edge on a computer, not a phone or a tablet. The radio’s programming cable. About ten
          minutes.
        </Point>
        <Point title="What flashing changes">
          The firmware. The OpenRTX{' '}
          <Out href={'https://openrtx.org/#/user_guide'} testid="intro-guide">
            users’ guide
          </Out>{' '}
          says it “will just replace your firmware without erasing your codeplug or other settings”. The
          backup step saves what the page can read first.
        </Point>
        <Point title="What does not work yet">
          OpenRTX does not do everything the original firmware does, and it differs per radio. Look your radio
          up on the{' '}
          <Out href={'https://openrtx.org/#/dev_status'} testid="intro-status">
            development status
          </Out>{' '}
          page before you flash.
        </Point>
        <Point title="How to go back">
          For most radios: flash the manufacturer’s firmware with the manufacturer’s tool, as for one of its
          own updates. The flash step says where a radio differs. Where the page can read a radio’s whole
          memory, the backup step keeps a copy it can flash back.
        </Point>
      </div>
    </details>
  );
}
