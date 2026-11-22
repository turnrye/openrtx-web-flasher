// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The drawing of a radio. The files are made at build time by scripts/art.mjs: the
 * CS7000 and MD-380 are Joshua Murphy's device mock-ups, the rest are drawn in the same
 * manner. Each radio also has an "enter" drawing with the keys to hold shown in gold.
 */

/** Shows the drawing of the radio with target name `id`. Decorative: text names the radio. */
export function RadioArt({ id, enter = false }: { id: string; enter?: boolean }) {
  return <img class="radio-art" src={`art/${id}${enter ? '-enter' : ''}.svg`} alt="" draggable={false} />;
}
