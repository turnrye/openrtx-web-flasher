// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Firmware builds the page can flash, and where their bytes come from.
 *
 * Releases and the latest master build are copied next to the site when it is built
 * (scripts/mirror-firmware.mjs writes firmware/manifest.json). Browsers refuse to let a
 * page download from GitHub releases or nightly.link, so everything else arrives as a
 * zip the user drops on the page, or through the GitHub API with their token.
 */
import { unzipSync } from 'fflate';
import { isBundle, openBundle, restorablePart, type BundleManifest } from '../backup/bundle.ts';
import { siteUrl } from '../base.ts';
import { pickFile, type Companion, type Radio } from '../radios.ts';

/** One firmware file of a build. */
export interface BuildFile {
  name: string;
  size: number;
  /** URL relative to the site, for mirrored files. */
  path?: string;
  /** SHA-256 hex, for mirrored files. */
  sha256?: string;
  /** Bytes, for files that came out of a zip or a local file. */
  data?: Uint8Array;
}

/** Where a build came from. */
export type BuildKind = 'release' | 'master' | 'ci' | 'local';

/** A set of firmware files built from one commit. */
export interface Build {
  id: string;
  kind: BuildKind;
  /** Short name: "v0.4.5", "master", "PR #588". */
  label: string;
  /** ISO date. */
  date?: string;
  /** Commit the build was made from. */
  sha?: string;
  /** Release page or workflow run. */
  url?: string;
  files: BuildFile[];
  /** Set when the build is a backup the user chose: what the bundle says about itself. */
  backup?: BundleManifest;
}

/** firmware/manifest.json as written by scripts/mirror-firmware.mjs. */
export interface Manifest {
  generated: string;
  /** "owner/repo" the builds were copied from. */
  source: string;
  builds: Build[];
}

/** Loads the list of mirrored builds; resolves to null when the site was built without them. */
export async function loadManifest(base: string = siteUrl()): Promise<Manifest | null> {
  try {
    const response = await fetch(new URL('firmware/manifest.json', base));
    if (!response.ok) return null;
    return (await response.json()) as Manifest;
  } catch {
    return null;
  }
}

/** SHA-256 of `bytes` as lower-case hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Returns the bytes of `file`, downloading and checking a mirrored file when needed. */
export async function fileBytes(file: BuildFile, base: string = siteUrl()): Promise<Uint8Array> {
  if (file.data) return file.data;
  if (!file.path) throw new Error(`${file.name} has no data`);
  const response = await fetch(new URL(file.path, base));
  if (!response.ok) throw new Error(`Could not download ${file.name} (HTTP ${response.status})`);
  const data = new Uint8Array(await response.arrayBuffer());
  if (file.sha256 && (await sha256Hex(data)) !== file.sha256) {
    throw new Error(`${file.name} does not match its checksum; reload the page and try again`);
  }
  return data;
}

/** True when `bytes` starts like a zip archive. */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Unpacks a CI artifact zip into build files, skipping folders. */
export function filesFromZip(zip: Uint8Array): BuildFile[] {
  return (
    Object.entries(unzipSync(zip))
      .filter(([name, data]) => !name.endsWith('/') && data.length > 0)
      // The last part of the name, whichever separator the zip was made with: a name is
      // never a path to write to.
      .map(([name, data]) => ({ name: name.split(/[\\/]/).pop()!, size: data.length, data }))
      .filter((file) => file.name !== '' && file.name !== '.' && file.name !== '..')
  );
}

/** Turns a file the user picked or dropped (a firmware file or a CI zip) into a build. */
export async function buildFromLocalFile(file: File): Promise<Build> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isZip(bytes) && isBundle(bytes)) return buildFromBundle(file.name, bytes);
  const files = isZip(bytes) ? filesFromZip(bytes) : [{ name: file.name, size: bytes.length, data: bytes }];
  return { id: `local:${file.name}`, kind: 'local', label: file.name, files };
}

/**
 * Turns a backup bundle into a build. Its one file is the image the page can write
 * back; a bundle the page cannot write back (one read from the original firmware) gives
 * a build with no files. `backup` says which radio model it belongs to. Throws when the
 * bundle is damaged.
 */
export async function buildFromBundle(name: string, zip: Uint8Array): Promise<Build> {
  const bundle = await openBundle(zip);
  const part = restorablePart(bundle);
  return {
    id: `backup:${name}`,
    kind: 'local',
    label: `Backup of ${new Date(bundle.manifest.taken).toLocaleDateString()}`,
    date: bundle.manifest.taken,
    backup: bundle.manifest,
    files: part ? [{ name: part.file, size: part.data.length, data: part.data }] : [],
  };
}

/**
 * The file of `build` that goes onto `radio`: the image of a backup of that model, or
 * the firmware file built for it.
 */
export function fileForRadio(radio: Radio, build: Build | null | undefined): BuildFile | undefined {
  if (!build) return undefined;
  if (build.backup) return build.backup.radio === radio.id ? build.files.at(0) : undefined;
  const name = pickFile(
    radio,
    build.files.map((f) => f.name),
  );
  return build.files.find((f) => f.name === name);
}

/** A companion image of a radio, with the file of the build that holds it, if the build has it. */
export interface CompanionFile extends Companion {
  found?: BuildFile;
}

/**
 * The images `radio` needs written next to its firmware file, matched against what
 * `build` holds. A backup is the whole flash already, so it needs none.
 */
export function companionsFor(radio: Radio, build: Build): CompanionFile[] {
  if (build.backup) return [];
  return (radio.alsoWrites ?? []).map((companion) => ({
    ...companion,
    // By its plain name, or in the radio's folder as the firmware mirror keeps it.
    found: build.files.find((f) => f.name === companion.file || f.name === `${radio.id}/${companion.file}`),
  }));
}

/** Starts a browser download of `data` as `name`. */
export function saveFile(name: string, data: Uint8Array): void {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([data as BlobPart], { type: 'application/octet-stream' }));
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}
