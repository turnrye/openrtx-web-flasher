// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The drawing of a radio. The files are made at build time by scripts/art.mjs: the
 * CS7000 and MD-380 are Joshua Murphy's device mock-ups, the rest are drawn in the same
 * manner. Each radio also has an "enter" drawing with the keys to hold shown in gold.
 */
import { siteUrl } from '../base.ts';

/**
 * Shows the drawing of the radio with target name `id`, as large as `class` says.
 * Decorative: text names the radio.
 */
export function RadioArt(props: { id: string; enter?: boolean; class?: string }) {
  return (
    <img
      class={`object-contain select-none ${props.class ?? ''}`}
      src={siteUrl(`art/${props.id}${props.enter ? '-enter' : ''}.svg`)}
      alt=""
      draggable={false}
    />
  );
}
