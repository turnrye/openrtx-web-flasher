// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * radios.json: the flasher's radios for other sites, the OpenRTX website first. It is
 * written at build time (site/pages/radios.json.ts) and its shape is a contract: change
 * it only together with its readers, and raise `version` when a change breaks them.
 */
import { fileForRadio, type Build } from './firmware/builds.ts';
import type { M17Support, Maker, Radio } from './radios.ts';

/** One radio as radios.json gives it. */
export interface RadioEntry {
  id: string;
  name: string;
  aka?: string;
  maker: Maker;
  alsoSoldBy?: Maker[];
  /** Whether the newest mirrored release has a file for it; true for all without a release. */
  inRelease: boolean;
  m17: M17Support;
  /** Its drawing, relative to `flasher`. */
  art: string;
  /** The flasher with this radio chosen, relative to `flasher`. */
  flash: string;
}

/** The whole of radios.json. */
export interface RadiosJson {
  version: 1;
  /** ISO time the site was built. */
  generated: string;
  /** Absolute address of the flasher's top, or its base path when the build has no site address. */
  flasher: string;
  /** The newest mirrored release, or null when the build mirrored none. */
  release: { id: string; date: string; url: string } | null;
  radios: RadioEntry[];
}

/**
 * Builds radios.json from the catalogue and the newest release the build mirrored.
 * @param radios the catalogue, in its order
 * @param release the newest release build, or undefined without one
 * @param flasher the flasher's top: an absolute URL, or the base path
 * @param generated the build's time, as an ISO string
 * @returns the document, ready for JSON.stringify
 */
export function buildRadiosJson(
  radios: readonly Radio[],
  release: Build | undefined,
  flasher: string,
  generated: string,
): RadiosJson {
  return {
    version: 1,
    generated,
    flasher,
    release: release ? { id: release.id, date: release.date ?? '', url: release.url ?? '' } : null,
    radios: radios.map((radio) => ({
      id: radio.id,
      name: radio.name,
      ...(radio.aka ? { aka: radio.aka } : {}),
      maker: radio.maker,
      ...(radio.alsoSoldBy?.length ? { alsoSoldBy: [...radio.alsoSoldBy] } : {}),
      inRelease: release ? Boolean(fileForRadio(radio, release)) : true,
      m17: {
        need: radio.m17.need,
        ...(radio.m17.note ? { note: radio.m17.note } : {}),
        ...(radio.m17.guide ? { guide: radio.m17.guide } : {}),
      },
      art: `art/${radio.id}.svg`,
      flash: `#${radio.id}`,
    })),
  };
}
