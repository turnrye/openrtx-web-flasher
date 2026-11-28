// SPDX-License-Identifier: GPL-3.0-or-later
/** The parts of the page around flashing: choosing, branch builds, settings, fallbacks. */
import { expect, test, type Page } from '@playwright/test';
import { zipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { answerRuns, enter, flash, pickBuild, radioCards, skipBackup, skipToFlash, step } from './flow.ts';

test('loads from a sub-path with no failed requests or console errors', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('response', (r) => r.status() >= 400 && problems.push(`${r.status()} ${r.url()}`));
  await page.goto('');
  await expect(page.getByRole('heading', { name: 'Flash your radio', level: 1 })).toBeVisible();
  await expect(page.getByTestId('radio-md3x0')).toBeVisible();
  await expect(page.getByTestId('sim-banner')).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('the rest of the site loads from the same sub-path: the home page and a page of the guide', async ({
  page,
}) => {
  const problems: string[] = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('response', (r) => r.status() >= 400 && problems.push(`${r.status()} ${r.url()}`));
  await page.goto('../');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Free firmware');
  // The hero's first action leads to the flasher.
  await page.getByRole('link', { name: 'Flash your radio' }).first().click();
  await expect(page.getByTestId('radio-md3x0')).toBeVisible();
  await page.goto('../user_guide/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(problems).toEqual([]);
});

test('every radio has a drawing, and one showing how to enter flashing mode', async ({ page }) => {
  await page.goto('');
  const cards = radioCards(page);
  await expect(cards).toHaveCount(13);
  // Each card's own drawing, and the one beside it that shows the keys to hold.
  const drawings = await cards.evaluateAll((all) =>
    all.flatMap((card) => {
      const shown = card.querySelector('img')!.src;
      return [shown, shown.replace(/\.svg$/, '-enter.svg')];
    }),
  );
  expect(drawings).toHaveLength(26);
  // A drawing that failed to load or parse has no natural size.
  const broken = await page.evaluate(async (addresses) => {
    const bad: string[] = [];
    for (const address of addresses) {
      const image = new Image();
      image.src = address;
      await image.decode().catch(() => bad.push(address));
      if (image.naturalWidth === 0 && !bad.includes(address)) bad.push(address);
    }
    return bad;
  }, drawings);
  expect(broken).toEqual([]);
});

test('one step is open at a time, and later steps wait for the ones before them', async ({ page }) => {
  await page.goto('');
  await expect(step(page, 'step-radio')).toHaveAttribute('data-mode', 'open');
  await expect(step(page, 'step-firmware')).toHaveAttribute('data-mode', 'waiting');
  await expect(page.getByTestId('builds')).toHaveCount(0);

  // Choosing a radio folds the grid to its bar and opens the firmware step.
  await page.getByTestId('radio-gd77').click();
  await expect(page).toHaveURL(/#gd77$/);
  await expect(step(page, 'step-radio')).toHaveAttribute('data-mode', 'folded');
  await expect(step(page, 'step-radio')).toContainText('Radioddity GD-77 · change');
  await expect(page.getByTestId('radio-gd77')).toBeHidden();
  await expect(page.getByTestId('builds')).toBeVisible();
  await expect(step(page, 'step-backup')).toHaveAttribute('data-mode', 'waiting');

  // Choosing a build opens the first thing to do with the radio: its backup, in normal mode.
  await pickBuild(page);
  await expect(step(page, 'step-backup')).toHaveAttribute('data-mode', 'open');
  await expect(step(page, 'step-enter')).toHaveAttribute('data-mode', 'waiting');
  await skipBackup(page);
  await expect(page.getByTestId('enter-steps')).toContainText('two side buttons');
  await expect(step(page, 'step-flash')).toHaveAttribute('data-mode', 'waiting');
  await enter(page);
  await expect(page.getByTestId('flash-step')).toBeVisible();

  // A folded step opens again from its bar.
  await page.getByTestId('open-step-radio').click();
  await expect(page.getByTestId('radio-gd77')).toBeVisible();
  await expect(step(page, 'step-flash')).toHaveAttribute('data-mode', 'folded');
});

test('the steps come in the order they happen for the radio', async ({ page }) => {
  const order = () =>
    page.evaluate(() => [...document.querySelectorAll('[data-testid="step"]')].map((s) => s.id));
  // The flasher is drawn after the page has loaded, so look until it is there.
  await page.goto('#md3x0');
  await expect
    .poll(order)
    .toEqual(['step-radio', 'step-firmware', 'step-backup', 'step-enter', 'step-flash']);
  await page.goto('#mod17');
  await page.reload();
  await expect
    .poll(order)
    .toEqual(['step-radio', 'step-firmware', 'step-enter', 'step-backup', 'step-flash']);
});

test('a radio link opens with that radio chosen', async ({ page }) => {
  await page.goto('#cs7000p');
  await expect(page.getByTestId('radio-cs7000p')).toHaveAttribute('aria-pressed', 'true');
  await expect(step(page, 'step-radio')).toContainText('Connect Systems CS7000-M17 Plus');
  await expect(step(page, 'step-firmware')).toHaveAttribute('data-mode', 'open');
});

test('warnings sit where they apply', async ({ page }) => {
  await page.goto('?sim=1');
  // There is no row of browser features in the top bar; support is said where it blocks.
  await expect(page.getByTestId('api-usb')).toHaveCount(0);

  await page.getByTestId('radio-cs7000p').click();
  await pickBuild(page);
  // Before the page asks for the radio, it says what flashes one with its maker's firmware.
  const instead = step(page, 'step-enter').getByTestId('use-instead');
  await expect(instead).toContainText('cannot be flashed from a browser');
  await expect(instead.getByRole('link', { name: 'cs7000plus_flasher by imostlylurk' })).toHaveAttribute(
    'href',
    'https://github.com/imostlylurk/cs7000plus_flasher',
  );
  await skipToFlash(page);
  await expect(page.getByTestId('flash-notes')).toContainText('second firmware slot');
  await expect(page.getByTestId('other-tool')).toHaveAttribute('open', '');
  await expect(page.getByTestId('other-tool').getByTestId('other-tools')).toContainText('Factory Tool');
});

test('experimental flashing is off by default, persists once on, and can be turned off', async ({ page }) => {
  await page.goto('?sim=1#mod17');
  await pickBuild(page);
  await skipToFlash(page, false);
  await expect(step(page, 'step-flash').getByTestId('needs-experimental')).toBeVisible();
  await expect(page.getByTestId('flash')).toHaveCount(0);
  await step(page, 'step-flash').getByTestId('turn-on-experimental').click();
  await expect(page.getByTestId('experimental-note')).toBeVisible();

  await page.reload();
  await pickBuild(page);
  await skipToFlash(page, false);
  await expect(page.getByTestId('flash')).toBeVisible();
  await page.getByTestId('turn-off-experimental').click();
  await expect(step(page, 'step-flash').getByTestId('needs-experimental')).toBeVisible();
});

test('a browser without WebUSB still gets the file and the command', async ({ page }) => {
  await page.addInitScript(() => {
    for (const api of ['usb', 'serial', 'hid'])
      delete (Navigator.prototype as unknown as Record<string, unknown>)[api];
  });
  await page.goto('#md3x0');
  await expect(page.getByTestId('no-apis')).toBeVisible();
  await pickBuild(page);
  await skipToFlash(page);
  await expect(page.getByTestId('unsupported')).toBeVisible();
  await expect(page.getByTestId('flash')).toHaveCount(0);
  // The tool to use instead is open, not folded away.
  await expect(page.getByTestId('other-tool')).toHaveAttribute('open', '');
  await expect(page.getByTestId('other-tool').getByTestId('command')).toContainText(
    'radio_tool -d 0 -f -i openrtx_md3x0_',
  );
  await expect(page.getByTestId('download').first()).toHaveAttribute('href', /openrtx_md3x0_.*\.bin$/);
});

test('a pull request build is found, downloaded by hand and dropped in', async ({ page }) => {
  const api = 'https://api.github.com/repos/OpenRTX/OpenRTX';
  const json = (body: unknown) => ({ contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(`${api}/pulls/588`, (r) => r.fulfill(json({ head: { sha: 'feedc0de00000000' } })));
  await page.route(`${api}/actions/runs?*`, (r) =>
    r.fulfill(
      json({
        workflow_runs: [
          {
            id: 77,
            path: '.github/workflows/main.yml',
            head_sha: 'feedc0de00000000',
            head_branch: 'fix',
            html_url: 'https://github.com/OpenRTX/OpenRTX/actions/runs/77',
            created_at: '2026-11-20T02:00:00Z',
            status: 'completed',
            conclusion: 'success',
          },
        ],
      }),
    ),
  );
  // What the user would get from the download link: a zip with the firmware inside.
  const firmware = new Uint8Array(40 * 1024).map((_, i) => (i * 7) & 0xff);
  firmware.set([0x00, 0x00, 0x02, 0x20, 0x01, 0x01, 0x00, 0x08]); // plausible stack pointer and reset vector
  const zip = Buffer.from(zipSync({ 'openrtx_mod17_fix.bin': firmware }));
  const digest = `sha256:${createHash('sha256').update(zip).digest('hex')}`;
  await page.route(`${api}/actions/runs/77/artifacts?*`, (r) =>
    r.fulfill(
      json({
        artifacts: [{ id: 5, name: 'openrtx-mod17', size_in_bytes: zip.length, expired: false, digest }],
      }),
    ),
  );

  await page.goto('?sim=1#mod17');
  await page.getByTestId('open-other').click();
  await page.getByTestId('open-ci').click();
  await page.getByTestId('ci-ref').fill('#588');
  await page.getByTestId('ci-find').click();
  await expect(page.getByTestId('ci-result')).toContainText('PR #588');
  await expect(page.getByTestId('ci-download')).toHaveAttribute(
    'href',
    'https://nightly.link/OpenRTX/OpenRTX/actions/runs/77/openrtx-mod17.zip',
  );
  // The download leaves the page in a new tab: the lookup stays where it is.
  await expect(page.getByTestId('ci-download')).toHaveAttribute('target', '_blank');

  await page
    .getByTestId('ci-panel')
    .getByTestId('file-input')
    .setInputFiles({ name: 'openrtx-mod17.zip', mimeType: 'application/zip', buffer: zip });

  // The firmware step folds and its bar says what was chosen.
  await expect(step(page, 'step-firmware')).toContainText('PR #588 · change');
  await expect(step(page, 'step-firmware').getByTestId('chosen-build')).toContainText('commit feedc0d');
  await skipToFlash(page);
  await expect(page.getByTestId('flash-step')).toContainText('PR #588 for the Module 17');
  // While the page can flash, the usual tool is folded away.
  await expect(page.getByTestId('other-tool')).not.toHaveAttribute('open', '');
  await flash(page);
  const problems = await page.evaluate(
    (bytes) => window.__ortxSim!.verify(Uint8Array.from(bytes)),
    Array.from(firmware),
  );
  expect(problems).toEqual([]);
});

test('a build without a file for the radio says so', async ({ page }) => {
  await page.goto('#md3x0');
  await page.getByTestId('open-other').click();
  await page.getByTestId('open-local').click();
  await page.getByTestId('file-input').setInputFiles({
    name: 'openrtx_gd77_test.sgl',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(64),
  });
  await expect(page.getByTestId('no-file')).toContainText('openrtx_gd77_test.sgl');
});

test('firmware is one of three choices: current release, development build, or other', async ({ page }) => {
  await page.goto('#mduv3x0');
  await expect(page.getByTestId('builds').locator('button')).toHaveCount(3);
  await expect(page.getByTestId('other-panel')).toHaveCount(0);

  // A tile is one click: the step folds and its bar carries the choice.
  await page.getByTestId('build-master').click();
  await expect(step(page, 'step-firmware')).toHaveAttribute('data-mode', 'folded');
  await expect(step(page, 'step-firmware')).toContainText('master · change');
  await expect(page.getByTestId('build-master')).toHaveAttribute('aria-pressed', 'true');

  // Past releases are under Other, and opening it drops the tile's choice.
  await page.getByTestId('open-step-firmware').click();
  await page.getByTestId('open-other').click();
  await expect(page.getByTestId('build-master')).toHaveAttribute('aria-pressed', 'false');
  await expect(step(page, 'step-backup')).toHaveAttribute('data-mode', 'waiting');
  const past = page.getByTestId('past-release');
  const value = await past.locator('option:not([disabled])').nth(1).getAttribute('value');
  await past.selectOption(value);
  await expect(step(page, 'step-firmware')).toContainText(`${value!} · change`);
  await expect(step(page, 'step-backup')).toHaveAttribute('data-mode', 'open');

  // Back to a tile closes Other.
  await page.getByTestId('open-step-firmware').click();
  await expect(page.getByTestId('open-other')).toContainText(value!);
  await page.locator('[data-testid^="build-"]:not([disabled])').first().click();
  await page.getByTestId('open-step-firmware').click();
  await expect(page.getByTestId('other-panel')).toHaveCount(0);
});

test('a radio without a release says so and offers the development build', async ({ page }) => {
  await page.goto('#md9600');
  const release = page.getByTestId('builds').locator('button').first();
  await expect(release).toBeDisabled();
  await expect(release).toContainText('None for this radio yet');
  await expect(release).toContainText('Use the development build');
  await expect(page.getByTestId('build-master')).toBeEnabled();
});

test('a chosen file shows as loaded, and can be swapped for another', async ({ page }) => {
  await page.goto('?sim=1#c62');
  await page.getByTestId('open-other').click();
  await page.getByTestId('open-local').click();

  // The zip GitHub CI makes for the C62: the application and the DSP image.
  const zip = Buffer.from(
    zipSync({ 'zephyr.bin': new Uint8Array(4096).fill(7), 'dsp_firmware.bin': new Uint8Array(2048) }),
  );
  const file = { name: 'openrtx-c62.zip', mimeType: 'application/zip', buffer: zip };
  await page.getByTestId('file-input').setInputFiles(file);

  // The step folds, its bar names the file, and the next step opens.
  await expect(step(page, 'step-firmware')).toContainText('openrtx-c62.zip · change');
  await expect(step(page, 'step-enter')).toHaveAttribute('data-mode', 'open');

  // Opened again, the file shows as loaded where it was given.
  await page.getByTestId('open-step-firmware').click();
  await expect(page.getByTestId('loaded')).toContainText('Loaded');
  await expect(page.getByTestId('loaded')).toContainText('openrtx-c62.zip');
  await expect(page.getByTestId('loaded')).toContainText('zephyr.bin');
  await expect(page.getByTestId('dropzone')).toHaveCount(0);

  await page.getByTestId('choose-another').click();
  await expect(page.getByTestId('dropzone')).toBeVisible();
  await expect(step(page, 'step-firmware')).not.toContainText('openrtx-c62.zip');
  await expect(step(page, 'step-enter')).toHaveAttribute('data-mode', 'waiting');

  // Both images of the zip are written: the flash step lists the second one.
  await page.getByTestId('file-input').setInputFiles(file);
  await skipToFlash(page);
  await expect(page.getByTestId('also-writes')).toContainText('dsp_firmware.bin');
  await expect(page.getByTestId('also-writes')).toContainText('0x100000');
  await expect(page.getByTestId('missing-companion')).toHaveCount(0);
});

test('a file dropped anywhere on the page shows up under Other, File', async ({ page }) => {
  await page.goto('#mod17');
  const data = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(2048)], 'openrtx_mod17_local.bin'));
    return transfer;
  });
  await page.dispatchEvent('body', 'drop', { dataTransfer: data });
  await expect(step(page, 'step-firmware')).toContainText('openrtx_mod17_local.bin · change');
  await expect(step(page, 'step-enter')).toHaveAttribute('data-mode', 'open');
  await page.getByTestId('open-step-firmware').click();
  await expect(page.getByTestId('file-panel').getByTestId('loaded')).toContainText('openrtx_mod17_local.bin');
});

test('a step folds and opens with motion, unless the reader asked for less, and folded content is out of reach', async ({
  page,
}) => {
  /**
   * Clicks an element and says whether anything of the page's steps is moving two frames
   * later. Done inside the page, so no time passes between the click and the look.
   */
  const movesAfterClick = (testid: string) =>
    page.evaluate(async (id) => {
      document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.click();
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      await frame();
      await frame();
      return [...document.querySelectorAll('[data-testid="step"]')].some(
        (section) => section.getAnimations({ subtree: true }).length > 0,
      );
    }, testid);
  /** The height of a step's content right now. */
  const bodyHeight = (id: string) =>
    page.evaluate(
      (step) => document.querySelector(`#${step} [data-testid="step-body"]`)!.getBoundingClientRect().height,
      id,
    );

  await page.goto('');
  await expect(page.getByTestId('radio-gd77')).toBeVisible();
  // The step that is open when the page loads is simply there.
  expect(
    await page.evaluate(() => document.querySelector('#step-radio')!.getAnimations({ subtree: true }).length),
  ).toBe(0);

  // Choosing a radio folds the picker and opens the firmware step, in motion.
  expect(await movesAfterClick('radio-gd77')).toBe(true);
  await expect(step(page, 'step-radio')).toHaveAttribute('data-mode', 'folded');
  // Once folded, the radio grid is out of sight, takes no room and is out of reach of Tab.
  await expect(page.getByTestId('radio-gd77')).toBeHidden();
  await expect.poll(() => bodyHeight('step-radio')).toBe(0);
  await page.getByTestId('open-step-radio').focus();
  await page.keyboard.press('Tab');
  expect(
    await page.evaluate(
      () => document.activeElement?.closest('#step-radio [data-testid="step-body"]') ?? null,
    ),
  ).toBeNull();
  // Tab went on to the open step instead.
  expect(await page.evaluate(() => !!document.activeElement?.closest('#step-firmware'))).toBe(true);

  // Opening it again from its bar moves too.
  expect(await movesAfterClick('open-step-radio')).toBe(true);
  await expect(page.getByTestId('radio-gd77')).toBeVisible();

  // With less motion asked for, the same change is there at once. The opening that is
  // under way was started with motion, so let it end first.
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await movesAfterClick('radio-md3x0')).toBe(false);
  expect(await bodyHeight('step-radio')).toBe(0);
  expect(await bodyHeight('step-firmware')).toBeGreaterThan(50);
  await expect(page.getByTestId('radio-md3x0')).toBeHidden();
  await expect(page.getByTestId('builds')).toBeVisible();
});

test('after a flash the page asks whether it worked, and the report holds no radio ID', async ({ page }) => {
  /** The title and body a report link would fill in. */
  const report = async (testid: string) => {
    const href = (await page.getByTestId(testid).getAttribute('href'))!;
    const query = new URL(href).searchParams;
    return { href, title: query.get('title')!, body: query.get('body')! };
  };

  await page.goto('?sim=1#cs7000p');
  await pickBuild(page);
  // Take a backup first, so the radio's ID is known to the page.
  await enter(page);
  await page.getByTestId('backup').click();
  await expect(page.getByTestId('backup-done')).toContainText('Radio ID: SIM0001');
  await page.getByTestId('backup-continue').click();
  await flash(page);

  // No radio is marked as checked yet, so the page asks.
  await expect(page.getByTestId('ask-worked')).toContainText('Did the radio start OpenRTX?');
  const worked = await report('report-worked');
  // Where reports go is a build setting; the link always fills in a title and a body.
  expect(worked.href).toMatch(/^https:\/\/[^?]+\/issues\/new\?title=/);
  expect(worked.title).toMatch(/^Worked: Connect Systems CS7000-M17 Plus with /);
  expect(worked.body).toContain('**Result:** the radio started OpenRTX');
  expect(worked.body).toContain('(cs7000p)');
  expect(worked.body).toMatch(/\*\*Firmware:\*\* .*openrtx_cs7000p_.*SHA-256 [0-9a-f]{64}/);
  expect(worked.body).toContain('**Backup:** saved, complete');
  expect(worked.body).toMatch(/\*\*Flasher build:\*\* [0-9a-f]{7}/);
  expect(worked.body).toContain('Finished.');
  // Nothing that tells this radio from another.
  expect(worked.body).not.toContain('SIM0001');
  await expect(page.getByTestId('report-worked')).toHaveAttribute('target', '_blank');

  const failed = await report('report-failed');
  expect(failed.title).toBe('Failed: Connect Systems CS7000-M17 Plus, flash');
  expect(failed.body).toContain('did not start OpenRTX');

  // The same report can be copied instead, to take somewhere else.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByTestId('copy-report').click();
  await expect(page.getByTestId('copy-report')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    '**Result:** the radio started OpenRTX',
  );

  // The footer has a plain way to say anything else.
  expect((await report('feedback')).title).toBe('Feedback: ');
});

test('a failed flash or backup offers to report it, with what the page logged', async ({ page }) => {
  await page.goto('?sim=fail#mod17');
  await pickBuild(page);
  await skipToFlash(page);
  await page.getByTestId('flash').click();
  await expect(page.getByTestId('flash-error')).toContainText('did not answer');
  await expect(page.getByTestId('ask-worked')).toHaveCount(0);
  const flashReport = new URL((await page.getByTestId('report-failed').getAttribute('href'))!).searchParams;
  expect(flashReport.get('title')).toBe('Failed: Module 17, flash');
  expect(flashReport.get('body')).toMatch(/\*\*Message:\*\* .*did not answer/);
  expect(flashReport.get('body')).toContain('**Backup:** skipped');
  expect(flashReport.get('body')).toMatch(/Failed: .*did not answer/);

  await page.goto('?sim=wrongmode#md3x0');
  await pickBuild(page);
  await answerRuns(page, 'original');
  await page.getByTestId('backup').click();
  await expect(page.getByTestId('backup-error')).toBeVisible();
  const link = step(page, 'step-backup').getByTestId('report-failed');
  const backupReport = new URL((await link.getAttribute('href'))!).searchParams;
  expect(backupReport.get('title')).toBe('Failed: Tytera MD-380 / MD-390, backup');
  expect(backupReport.get('body')).toContain('**Result:** backup failed');
  expect(backupReport.get('body')).toContain('The radio is in flashing mode');
});

test('a radio that was checked on hardware is not asked for more successes', async ({ page }) => {
  // The C62 is marked as checked (docs/verification.md).
  await page.goto('?sim=1#c62');
  await page.getByTestId('open-other').click();
  await page.getByTestId('open-local').click();
  const zip = Buffer.from(
    zipSync({ 'zephyr.bin': new Uint8Array(4096).fill(7), 'dsp_firmware.bin': new Uint8Array(2048) }),
  );
  await page
    .getByTestId('file-input')
    .setInputFiles({ name: 'openrtx-c62.zip', mimeType: 'application/zip', buffer: zip });
  await skipToFlash(page, false);

  // No experimental confirmation in any step, and the flash step says why.
  await expect(page.getByTestId('needs-experimental')).toHaveCount(0);
  await expect(page.getByTestId('verified')).toContainText('Checked on a real radio');
  await flash(page);

  // After a flash: no question, only a way to report a problem.
  await expect(page.getByTestId('ask-worked')).toHaveCount(0);
  await expect(page.getByTestId('report-worked')).toHaveCount(0);
  await expect(page.getByTestId('ask-problem')).toContainText('Not working?');
  const problem = new URL((await page.getByTestId('report-failed').getAttribute('href'))!).searchParams;
  expect(problem.get('title')).toBe('Failed: Retevis C62 / C2, flash');
});

test('the site footer leads to the licences and credits, with the licence texts', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('response', (r) => r.status() >= 400 && problems.push(`${r.status()} ${r.url()}`));
  await page.goto('');
  // The flasher's own footer no longer repeats it.
  await expect(page.getByTestId('licences')).toHaveCount(0);
  await page.getByTestId('site-licence').getByRole('link', { name: 'licences and credits' }).click();
  await expect(page.getByRole('heading', { name: 'Flasher licences and credits' })).toBeVisible();
  await expect(page.getByTestId('credit-radio_tool')).toContainText('GPL-3.0-or-later');
  await expect(page.getByTestId('credit-GD-77 firmware uploader')).toContainText('Roger Clark VK3KYY');
  await expect(page.getByTestId('credit-GD-77 firmware uploader')).toContainText('GPL-2.0-or-later');
  await expect(page.getByTestId('credit-cskburn')).toContainText('Apache-2.0');

  // Every licence named has its text on the page, folded until asked for.
  const texts = page.getByTestId('licence-text');
  await expect(texts).toHaveCount(10);
  for (const [title, words] of [
    ['GNU General Public License', 'GNU GENERAL PUBLIC LICENSE'],
    ['Apache License 2.0', 'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION'],
    ['MIT License (Preact)', 'Jason Miller'],
    ['MIT License (fflate)', 'Arjun Barrett'],
    ['Ubuntu Font Licence', 'UBUNTU FONT LICENCE'],
    ['SIL Open Font License 1.1 (VT323)', 'SIL OPEN FONT LICENSE Version 1.1'],
  ] as const) {
    const entry = texts.filter({ hasText: title });
    await expect(entry.locator('pre')).toBeHidden();
    await entry.locator('summary').click();
    await expect(entry.locator('pre')).toContainText(words);
  }
  expect(problems).toEqual([]);
});

test('Tab goes from the File choice to "Choose a file", which opens the file dialog', async ({ page }) => {
  await page.goto('?sim=1');
  await page.getByTestId('radio-md3x0').click();
  await page.getByTestId('open-other').click();
  await page.getByTestId('open-local').click();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('choose-file')).toBeFocused();
  const dialog = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  await dialog;
});

test('radios outside the current release fold away under "No release yet"', async ({ page }) => {
  await page.goto('');
  const group = page.getByTestId('no-release');
  await expect(page.getByTestId('radio-md3x0')).toBeVisible();
  await expect(group.locator('summary')).toContainText('No release yet');
  // In the release: in the main list, not in the group.
  await expect(group.getByTestId('radio-md3x0')).toHaveCount(0);
  await expect(group.getByTestId('radio-cs7000')).toHaveCount(0);
  // Not in it: folded away until the group is opened.
  for (const id of ['md9600', 'rt4d', 'rt950pro', 'ttwrplus', 'c62']) {
    await expect(group.getByTestId(`radio-${id}`)).toBeHidden();
  }
  await group.locator('summary').click();
  await page.getByTestId('radio-c62').click();
  await expect(step(page, 'step-radio')).toContainText('Retevis C62');

  // A link to such a radio opens with its group unfolded.
  await page.goto('#rt4d');
  await page.reload();
  await page.getByTestId('open-step-radio').click();
  await expect(page.getByTestId('radio-rt4d')).toBeVisible();
  await expect(page.getByTestId('radio-rt4d')).toHaveAttribute('aria-pressed', 'true');
});

/** Drops a file with this name and these bytes on the page. */
async function dropFile(page: Page, name: string, bytes: number[]): Promise<void> {
  const data = await page.evaluateHandle(
    ([fileName, content]) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([Uint8Array.from(content)], fileName));
      return transfer;
    },
    [name, bytes] as const,
  );
  await page.dispatchEvent('body', 'drop', { dataTransfer: data });
}

test('a file dropped again under the same name is the one that gets flashed', async ({ page }) => {
  const first = Array.from({ length: 4096 }, (_, i) => (i * 7) & 0xff);
  const second = Array.from({ length: 6144 }, (_, i) => (i * 13 + 5) & 0xff);
  await page.goto('?sim=1#mod17');
  await dropFile(page, 'openrtx_mod17_local.bin', first);
  await skipToFlash(page);
  await expect(page.getByTestId('flash')).toBeEnabled();

  // The flash step is open with the first file loaded; the rebuilt file has the same name.
  await dropFile(page, 'openrtx_mod17_local.bin', second);
  await expect(step(page, 'step-flash')).toContainText('6 KB');
  await flash(page);
  const problems = await page.evaluate((bytes) => window.__ortxSim!.verify(Uint8Array.from(bytes)), second);
  expect(problems).toEqual([]);
});

test('a file dropped while the radio is being written changes nothing', async ({ page }) => {
  await page.goto('?sim=slow#mod17');
  await pickBuild(page);
  const label = await step(page, 'step-firmware').getByTestId('step-state').innerText();
  await skipToFlash(page);
  await page.getByTestId('flash').click();
  await expect(page.getByTestId('flash').getByTestId('spinner')).toBeVisible();

  await dropFile(page, 'openrtx_mod17_other.bin', [1, 2, 3, 4]);
  await expect(page.getByTestId('done')).toBeVisible({ timeout: 60_000 });
  await expect(step(page, 'step-firmware')).not.toContainText('openrtx_mod17_other.bin');
  expect(await step(page, 'step-firmware').getByTestId('step-state').innerText()).toBe(label);
});

test('after a failed backup in flashing mode the radio is asked for again', async ({ page }) => {
  await page.goto('?sim=fail#mod17');
  await pickBuild(page);
  await enter(page);
  const backup = step(page, 'step-backup');
  await backup.getByTestId('backup').click();
  await expect(backup.getByRole('alert').first()).toBeVisible();
  expect(await page.evaluate(() => window.__ortxSimPicks)).toBe(1);

  // The radio has to be put in flashing mode again, which makes it a new device.
  await backup.getByTestId('backup').click();
  await expect.poll(() => page.evaluate(() => window.__ortxSimPicks)).toBe(2);
});
