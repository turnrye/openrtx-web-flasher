// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * For a radio the page cannot flash as it usually comes: why, and the tools that can.
 * Shown in the flashing-mode step, before the page asks for the radio, and again where
 * the flash step offers other tools.
 */
import type { OtherTool, Radio } from '../radios.ts';

/** The tools, one line each: name with its link, and what to do with it. */
export function OtherTools({ tools }: { tools: OtherTool[] }) {
  return (
    <ul data-testid="other-tools">
      {tools.map((t) => (
        <li key={t.url}>
          <a href={t.url} target="_blank" rel="noopener">
            {t.tool}
          </a>
          : {t.text}
        </li>
      ))}
    </ul>
  );
}

/** Why the page is not the way to flash this radio, and what is; nothing for other radios. */
export function UseInstead({ radio }: { radio: Radio }) {
  if (!radio.useInstead) return null;
  return (
    <div class="panel" data-testid="use-instead">
      <p>{radio.useInstead.why}</p>
      <OtherTools tools={radio.useInstead.tools} />
    </div>
  );
}
