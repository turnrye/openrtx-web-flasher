// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The backup file: a zip with the pieces that were read and a manifest, backup.json,
 * that says what each piece is, where it came from and its checksum. One format for
 * every radio, so a backup can be understood later without knowing how it was made.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { BackupPart, IdKind, PartKind, RadioBackup } from './types.ts';

/** Format name and version written into every manifest. */
export const BUNDLE_FORMAT = 'openrtx-backup/1';

/** How the radio was read. */
export type BundleSource =
  /** In its bootloader or flashing mode; the image can be written back the same way. */
  | 'flashing-mode'
  /** From the original firmware, in normal mode, with its programming-software protocol. */
  | 'original-firmware';

/** One part as the manifest describes it. */
export interface ManifestPart {
  file: string;
  kind: PartKind;
  address?: number;
  size: number;
  sha256: string;
  complete: boolean;
  note?: string;
}

/** backup.json. */
export interface BundleManifest {
  format: typeof BUNDLE_FORMAT;
  /** OpenRTX target name of the radio, e.g. "md9600". */
  radio: string;
  /** The radio's name, for people. */
  model: string;
  radioId: string | null;
  idKind: IdKind | null;
  /** When the backup was taken, ISO 8601. */
  taken: string;
  source: BundleSource;
  /** Firmware version the radio reported. */
  firmware?: string;
  notes: string[];
  parts: ManifestPart[];
  /** What made the bundle. */
  tool: { name: string; userAgent: string };
  /** Present when the backup was read from a simulated radio: it must never be written to a real one. */
  simulated?: true;
}

/** An opened bundle. */
export interface Bundle {
  manifest: BundleManifest;
  parts: BackupPart[];
}

/** SHA-256 of `bytes` as lower-case hex. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** "20261121-0605" in local time. */
function stamp(when: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}` +
    `-${pad(when.getHours())}${pad(when.getMinutes())}`
  );
}

/** The file name a bundle is saved under: backup_<radio>[_<end of its ID>]_<date>.zip. */
export function bundleFileName(manifest: BundleManifest): string {
  const id = manifest.radioId ? `_${manifest.radioId.slice(-8).toLowerCase()}` : '';
  return `backup_${manifest.radio}${id}_${stamp(new Date(manifest.taken))}.zip`;
}

/** Packs what was read from a radio into a bundle. */
export async function makeBundle(
  radio: { id: string; name: string },
  backup: RadioBackup,
  source: BundleSource,
  when: Date,
): Promise<{ name: string; zip: Uint8Array; manifest: BundleManifest }> {
  const parts: ManifestPart[] = [];
  const files: Record<string, Uint8Array> = {};
  for (const part of backup.parts) {
    if (files[part.file]) throw new Error(`two parts are both called ${part.file}`);
    files[part.file] = part.data;
    parts.push({
      file: part.file,
      kind: part.kind,
      ...(part.address === undefined ? {} : { address: part.address }),
      size: part.data.length,
      sha256: await sha256Hex(part.data),
      complete: part.complete,
      ...(part.note ? { note: part.note } : {}),
    });
  }
  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT,
    radio: radio.id,
    model: radio.name,
    radioId: backup.radioId,
    idKind: backup.idKind,
    taken: when.toISOString(),
    source,
    ...(backup.firmware ? { firmware: backup.firmware } : {}),
    notes: backup.notes,
    parts,
    tool: {
      name: 'openrtx-web-flasher',
      userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    },
    ...(backup.simulated ? { simulated: true as const } : {}),
  };
  // Stored, not compressed: firmware and flash dumps barely shrink, and a plain zip
  // can be picked apart with any tool.
  const zip = zipSync({ 'backup.json': strToU8(JSON.stringify(manifest, null, 2)), ...files }, { level: 0 });
  return { name: bundleFileName(manifest), zip, manifest };
}

/** True when `zip` is a backup bundle rather than, say, a CI build. */
export function isBundle(zip: Uint8Array): boolean {
  try {
    // At the root, or in the folder a re-zipped backup ends up in (openBundle takes both).
    const found = unzipSync(zip, {
      filter: (file) => file.name === 'backup.json' || file.name.endsWith('/backup.json'),
    });
    return Object.keys(found).length > 0;
  } catch {
    return false;
  }
}

/**
 * Opens a bundle and checks every part against the manifest. Throws with a message a
 * person can read when the file is not a bundle, is of a newer format, or a part is
 * missing or does not match its checksum.
 */
export async function openBundle(zip: Uint8Array): Promise<Bundle> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip);
  } catch {
    throw new Error('This file is not a backup: it could not be opened as a zip.');
  }
  // macOS's Compress wraps an unpacked backup in a folder; accept that.
  const prefix = Object.keys(files)
    .find((name) => name.endsWith('backup.json'))
    ?.replace(/backup\.json$/, '');
  if (prefix === undefined) throw new Error('This zip is not a backup: it has no backup.json.');
  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(strFromU8(files[`${prefix}backup.json`])) as BundleManifest;
  } catch {
    throw new Error('This backup is damaged: its backup.json cannot be read.');
  }
  if (manifest.format !== BUNDLE_FORMAT) {
    throw new Error(`This backup is in a format this page does not know (${String(manifest.format)}).`);
  }
  const parts: BackupPart[] = [];
  for (const part of manifest.parts) {
    const data = files[`${prefix}${part.file}`];
    if (!data) throw new Error(`This backup is damaged: ${part.file} is missing.`);
    if (data.length !== part.size || (await sha256Hex(data)) !== part.sha256) {
      throw new Error(`This backup is damaged: ${part.file} does not match its checksum.`);
    }
    parts.push({
      file: part.file,
      kind: part.kind,
      address: part.address,
      data,
      complete: part.complete,
      note: part.note,
    });
  }
  return { manifest, parts };
}

/**
 * The part of a bundle this page can write back, with the address it goes to, or null.
 * Only an image read in flashing mode can be: it is written the way firmware is. What
 * was read from the original firmware (codeplug, factory data) is a record to keep;
 * the page has no way to write it.
 */
export function restorablePart(bundle: Bundle): BackupPart | null {
  if (bundle.manifest.source !== 'flashing-mode') return null;
  return bundle.parts.find((part) => part.kind === 'internal-flash' && part.complete) ?? null;
}

/** Bytes in all parts. */
export function bundleSize(manifest: BundleManifest): number {
  return manifest.parts.reduce((sum, part) => sum + part.size, 0);
}
