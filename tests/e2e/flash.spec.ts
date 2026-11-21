// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The happy path, per radio, in a real Chromium: pick the radio, pick a build, go
 * through the steps (the backup is skipped here; backup.spec.ts and stock-backup.spec.ts
 * take real ones), turn on experimental flashing, flash, and then ask the simulated
 * radio whether it holds exactly the firmware file the page offered. The firmware is the real OpenRTX build
 * that ci/build.sh mirrored into the site.
 */
import { expect, test, type Page } from '@playwright/test';
import { zipSync } from 'fflate';
import { flash, pickBuild, pickRadio, skipToFlash, step } from './flow.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface ManifestFile {
  name: string;
  path: string;
}
interface ManifestBuild {
  id: string;
  kind: string;
  files: ManifestFile[];
}

const manifestPath = fileURLToPath(new URL('../../dist/firmware/manifest.json', import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { builds: ManifestBuild[] };

/** Radios flashed from the browser, and the extension of the file each one takes. */
const FLASHED: [id: string, ext: string][] = [
  ['md3x0', 'bin'],
  ['mduv3x0', 'bin'],
  ['md9600', 'bin'],
  ['dm1701', 'bin'],
  ['gd77', 'sgl'],
  ['dm1801', 'sgl'],
  ['cs7000', 'dfu'],
  ['cs7000p', 'dfu'],
  ['rt4d', 'bin'],
  ['mod17', 'bin'],
];

/** Radios marked as checked on hardware (docs/verification.md): they ask for no confirmation. */
const CHECKED = ['cs7000'];

/** Builds in the manifest that have a file for the radio. */
function buildsFor(id: string, ext: string): ManifestBuild[] {
  return manifest.builds.filter((b) =>
    b.files.some((f) => f.name.startsWith(`openrtx_${id}_`) && f.name.endsWith(ext)),
  );
}

/**
 * Asks the simulated radio whether it holds the file behind the page's download link.
 * `tampered` is the same question for that file with one byte changed: it must find a
 * problem, or the check proves nothing.
 */
async function simProblems(page: Page): Promise<{ problems: string[]; tampered: string[] }> {
  return page.evaluate(async () => {
    const link = document.querySelector<HTMLAnchorElement>('[data-testid="download"]')!;
    const firmware = new Uint8Array(await (await fetch(link.href)).arrayBuffer());
    const changed = firmware.slice();
    changed[changed.length >> 1] ^= 0x5a;
    let tampered: string[];
    try {
      tampered = window.__ortxSim!.verify(changed);
    } catch (e) {
      tampered = [`rejected: ${String(e)}`];
    }
    return { problems: window.__ortxSim!.verify(firmware), tampered };
  });
}

test('the mirrored firmware covers the development build and at least one release', () => {
  expect(manifest.builds.some((b) => b.kind === 'master')).toBe(true);
  expect(manifest.builds.some((b) => b.kind === 'release')).toBe(true);
});

for (const [id, ext] of FLASHED) {
  const builds = buildsFor(id, ext);
  // The development build has every radio; releases are checked too where they have one.
  const picks = [builds.find((b) => b.kind === 'master'), builds.find((b) => b.kind === 'release')].filter(
    (b): b is ManifestBuild => !!b,
  );

  test(`${id}: has a build to flash`, () => {
    expect(picks.length).toBeGreaterThan(0);
  });

  for (const build of picks) {
    test(`${id}: flashes ${build.id} into the simulated radio`, async ({ page }) => {
      await page.goto('?sim=1');
      await pickRadio(page, id);
      await page.getByTestId(`build-${build.id}`).click();
      await expect(step(page, 'step-firmware')).toHaveAttribute('data-mode', 'folded');

      await skipToFlash(page, false);
      if (CHECKED.includes(id)) {
        await expect(page.getByTestId('verified')).toContainText('Checked on a real radio');
        await expect(page.getByTestId('needs-experimental')).toHaveCount(0);
      } else {
        // Off by default until the radio has been checked on hardware.
        await expect(page.getByTestId('flash')).toHaveCount(0);
        await step(page, 'step-flash').getByTestId('turn-on-experimental').click();
      }

      await flash(page);
      await expect(page.getByTestId('percent')).toHaveText('100%');
      const result = await simProblems(page);
      expect(result.problems).toEqual([]);
      expect(result.tampered).not.toEqual([]);
    });
  }
}

test('c62: flashes the application and the DSP image of a build zip in one run', async ({ page }) => {
  const app = Buffer.alloc(96 * 1024 + 77);
  for (let i = 0; i < app.length; i++) app[i] = (i * 31 + (i >> 8)) & 0xff;
  const dsp = Buffer.alloc(120 * 1024 + 5);
  for (let i = 0; i < dsp.length; i++) dsp[i] = (i * 17 + (i >> 7)) & 0xff;
  // What GitHub CI puts in openrtx-c62.zip.
  const zip = Buffer.from(zipSync({ 'zephyr.bin': app, 'dsp_firmware.bin': dsp }));

  await page.goto('?sim=1');
  await pickRadio(page, 'c62');
  await page.getByTestId('open-other').click();
  await page.getByTestId('open-local').click();
  await page
    .getByTestId('file-input')
    .setInputFiles({ name: 'openrtx-c62.zip', mimeType: 'application/zip', buffer: zip });
  await skipToFlash(page);
  await expect(page.getByTestId('also-writes')).toContainText('dsp_firmware.bin');
  await flash(page);

  // The radio holds the application at 0x0 and the DSP image at 0x100000: OpenRTX loads
  // its DSP from there at every start, and does not come up without it.
  const held = await page.evaluate(
    ([appLength, dspLength]) => ({
      app: Array.from(window.__ortxSim!.read!(0, appLength)),
      dsp: Array.from(window.__ortxSim!.read!(0x100000, dspLength)),
    }),
    [app.length, dsp.length],
  );
  expect(Buffer.compare(Buffer.from(held.app), app)).toBe(0);
  expect(Buffer.compare(Buffer.from(held.dsp), dsp)).toBe(0);
  await page.locator('#step-flash').getByTestId('console').locator('summary').click();
  await expect(page.locator('#step-flash').getByTestId('log')).toContainText('Burning partition 2/2');
});

test('c62: an application file alone can be flashed, with a warning that the DSP image is missing', async ({
  page,
}) => {
  const firmware = Buffer.alloc(96 * 1024 + 77);
  for (let i = 0; i < firmware.length; i++) firmware[i] = (i * 31 + (i >> 8)) & 0xff;

  await page.goto('?sim=1');
  await pickRadio(page, 'c62');
  await page.getByTestId('open-other').click();
  await page.getByTestId('open-local').click();
  await page
    .getByTestId('file-input')
    .setInputFiles({ name: 'zephyr.bin', mimeType: 'application/octet-stream', buffer: firmware });
  await skipToFlash(page);
  await expect(page.getByTestId('missing-companion')).toContainText('black screen');
  await flash(page);
  const problems = await page.evaluate(
    (bytes) => window.__ortxSim!.verify(Uint8Array.from(bytes)),
    Array.from(firmware),
  );
  expect(problems).toEqual([]);
});

test('rt950pro: flashes a .BTF the user brings', async ({ page }) => {
  // Shaped like the port's build: the model name the bootloader looks for at 0x3E0.
  const btf = Buffer.alloc(40 * 1024);
  for (let i = 0; i < btf.length; i++) btf[i] = (i * 29 + (i >> 9)) & 0xff;
  btf.write('RT-950      ', 0x3e0, 'latin1');

  await page.goto('?sim=1');
  await pickRadio(page, 'rt950pro');
  await page.getByTestId('open-other').click();
  await page.getByTestId('open-local').click();
  await page
    .getByTestId('file-input')
    .setInputFiles({ name: 'openrtx_rt950pro.BTF', mimeType: 'application/octet-stream', buffer: btf });
  await expect(step(page, 'step-firmware')).toHaveAttribute('data-mode', 'folded');

  // The firmware cannot be read, so the backup step says where Radtel publishes it.
  await expect(page.getByTestId('backup-not-included').locator('a')).toHaveAttribute(
    'href',
    'https://www.radtels.com/pages/software-download',
  );
  await skipToFlash(page);
  await expect(page.getByTestId('flash-notes')).toContainText("Radtel's update tool");
  await flash(page);
  const problems = await page.evaluate(
    (bytes) => window.__ortxSim!.verify(Uint8Array.from(bytes)),
    Array.from(btf),
  );
  expect(problems).toEqual([]);
});

test('rt950pro: a file for another radio is refused before anything is sent', async ({ page }) => {
  const wrong = Buffer.alloc(40 * 1024, 0x5a);
  await page.goto('?sim=1');
  await pickRadio(page, 'rt950pro');
  await page.getByTestId('open-other').click();
  await page.getByTestId('open-local').click();
  await page
    .getByTestId('file-input')
    .setInputFiles({ name: 'something.btf', mimeType: 'application/octet-stream', buffer: wrong });
  await skipToFlash(page);
  await page.getByTestId('flash').click();
  await expect(step(page, 'step-flash')).toContainText('not an RT-950 Pro .BTF file');
});

test('ttwrplus: offers the UF2 file to copy instead of flashing', async ({ page }) => {
  const build =
    buildsFor('ttwrplus', 'uf2')[0] ??
    manifest.builds.find((b) => b.files.some((f) => f.name.endsWith('.uf2')));
  test.skip(!build, 'no T-TWR Plus build in the mirror');
  await page.goto('?sim=1');
  await pickRadio(page, 'ttwrplus');
  await page.getByTestId(`build-${build.id}`).click();
  await skipToFlash(page);
  await expect(page.getByTestId('flash')).toHaveCount(0);
  await expect(page.getByTestId('flash-notes')).toContainText('sa8x8');
  await expect(page.getByTestId('download')).toHaveAttribute('href', /\.uf2$/);
});

test('a radio that does not answer ends in a clear error, and can be retried', async ({ page }) => {
  await page.goto('?sim=fail');
  await page.getByTestId('radio-mod17').click();
  await pickBuild(page);
  await skipToFlash(page);
  await page.getByTestId('flash').click();
  await expect(page.getByTestId('flash-error')).toContainText('did not answer');
  await expect(page.getByTestId('flash')).toHaveText('Flash again');
});
