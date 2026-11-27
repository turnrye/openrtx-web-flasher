// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What the page says and asks around the flashing itself: before the first step, at the
 * choices, before the browser's device list, after a flash and after a failure. Three
 * walk-throughs (a first-timer, someone upgrading, someone flashing branch builds) found
 * these missing; each test here is one of their findings.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { zipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  answerRuns,
  enter,
  flash,
  pickBuild,
  pickRadio,
  radioCards,
  skipBackup,
  skipToFlash,
  step,
  turnOnExperimental,
} from './flow.ts';

// Dates are shown in the reader's language and time zone; the tests read them in one.
test.use({ locale: 'en-GB', timezoneId: 'UTC' });

interface ManifestBuild {
  id: string;
  kind: string;
  label: string;
  date: string;
  sha?: string;
  url: string;
}

const manifestPath = fileURLToPath(new URL('../../dist/firmware/manifest.json', import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { builds: ManifestBuild[] };
const release = manifest.builds.find((b) => b.kind === 'release')!;
const master = manifest.builds.find((b) => b.kind === 'master')!;

/** A date as the page shows it to this reader, as a pattern: "25 Nov 2026, 17:20". */
function shown(iso: string): RegExp {
  const at = new Date(iso);
  const two = (n: number) => String(n).padStart(2, '0');
  return new RegExp(
    `${at.getUTCDate()} \\w+ ${at.getUTCFullYear()}.{1,5}${two(at.getUTCHours())}:${two(at.getUTCMinutes())}`,
  );
}

/** The brand gold, as a browser reports a colour: the page's one primary action per step wears it. */
const GOLD = 'rgb(250, 180, 19)';

/** The background colour of a button. */
function background(button: Locator): Promise<string> {
  return button.evaluate((element) => getComputedStyle(element).backgroundColor);
}

/** Makes every device list of the browser close without a pick, as when the user presses Cancel. */
async function cancelEveryChooser(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const cancel = () => Promise.reject(new DOMException('No device selected.', 'NotFoundError'));
    for (const api of ['usb', 'serial', 'hid']) {
      const devices = (navigator as unknown as Record<string, Record<string, unknown> | undefined>)[api];
      if (devices) {
        devices.requestDevice = cancel;
        devices.requestPort = cancel;
      }
    }
  });
}

/** Answers the GitHub API for pull request 588 of OpenRTX with one run and one artifact. */
async function fakePullRequest(page: Page, artifact: Record<string, unknown>): Promise<void> {
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
            created_at: '2026-11-20T02:05:00Z',
            status: 'completed',
            conclusion: 'success',
          },
        ],
      }),
    ),
  );
  await page.route(`${api}/actions/runs/77/artifacts?*`, (r) =>
    r.fulfill(json({ artifacts: [{ id: 5, name: 'openrtx-mod17', expired: false, ...artifact }] })),
  );
}

/** A zip like the one CI makes for the Module 17, with `fill` as its firmware's bytes. */
function mod17Zip(fill: number): Buffer {
  const firmware = new Uint8Array(24 * 1024).fill(fill);
  firmware.set([0x00, 0x00, 0x02, 0x20, 0x01, 0x01, 0x00, 0x08]);
  return Buffer.from(zipSync({ 'openrtx_mod17_fix.bin': firmware }));
}

/** Looks pull request 588 up on the Module 17's page and drops `zip` as its download. */
async function lookUpAndDrop(page: Page, zip: Buffer): Promise<void> {
  await page.getByTestId('open-other').click();
  await page.getByTestId('open-ci').click();
  await page.getByTestId('ci-ref').fill('#588');
  await page.getByTestId('ci-find').click();
  await expect(page.getByTestId('ci-result')).toContainText('PR #588');
  await page
    .getByTestId('ci-panel')
    .getByTestId('file-input')
    .setInputFiles({ name: 'openrtx-mod17.zip', mimeType: 'application/zip', buffer: zip });
}

test('a "Before you start" block sits above step 1, and stays folded once folded', async ({ page }) => {
  await page.goto('');
  const block = page.getByTestId('before-you-start');
  await expect(block).toHaveAttribute('open', '');
  // Above the first step.
  const order = await page.evaluate(() =>
    document
      .querySelector('[data-testid="before-you-start"]')!
      .compareDocumentPosition(document.querySelector('#step-radio')!),
  );
  expect(order & 4).toBe(4); // DOCUMENT_POSITION_FOLLOWING

  // What you need, what changes, what does not work yet, how to go back.
  await expect(block).toContainText('Chrome or Edge on a computer');
  await expect(block).toContainText('programming cable');
  await expect(block).toContainText('About ten minutes');
  // The users' guide is quoted, not outbid.
  await expect(block).toContainText(
    '“will just replace your firmware without erasing your codeplug or other settings”',
  );
  await expect(block).toContainText('What does not work yet');
  await expect(block).toContainText('manufacturer’s firmware');
  for (const [testid, path] of [
    ['intro-guide', /\/user_guide\/$/],
    ['intro-status', /\/dev_status\/$/],
  ] as const) {
    const link = block.getByTestId(testid);
    await expect(link).toHaveAttribute('href', path);
    await expect(link).toHaveAttribute('target', '_blank');
    // The page it names is part of the site.
    expect((await page.request.get((await link.getAttribute('href'))!)).ok()).toBe(true);
  }

  // Someone who has read it folds it away, and it stays away.
  await block.locator('summary').click();
  await expect(block).not.toHaveAttribute('open', '');
  await expect(block.getByText('What you need')).toBeHidden();
  await page.reload();
  await expect(page.getByTestId('radio-md3x0')).toBeVisible();
  await expect(page.getByTestId('before-you-start')).not.toHaveAttribute('open', '');
  await page.getByTestId('before-you-start').locator('summary').click();
  await expect(page.getByTestId('before-you-start').getByText('What you need')).toBeVisible();
});

test('every radio card says whether flashing it from this page was checked on a real radio', async ({
  page,
}) => {
  await page.goto('');
  const cards = radioCards(page);
  await expect(cards).toHaveCount(13);
  await expect(cards.getByTestId('checked-badge')).toHaveCount(13);
  // docs/verification.md: the MD-UV380, the DM-1701, the CS7000-M17 and the C62 are checked.
  await expect(page.getByTestId('radio-cs7000').getByTestId('checked-badge')).toHaveText('Checked');
  await expect(page.getByTestId('radio-mduv3x0').getByTestId('checked-badge')).toHaveText('Checked');
  await expect(page.getByTestId('radio-dm1701').getByTestId('checked-badge')).toHaveText('Checked');
  await expect(page.getByTestId('radio-md3x0').getByTestId('checked-badge')).toHaveText('Not checked yet');
  await expect(cards.locator('[data-checked="yes"]')).toHaveCount(4);
  await expect(page.getByTestId('checked-legend')).toContainText('started OpenRTX');

  // Both groups carry the badge: the release's radios and the ones without a release.
  const unreleased = page.getByTestId('no-release');
  await unreleased.locator('summary').click();
  await expect(unreleased.getByTestId('radio-c62').getByTestId('checked-badge')).toHaveText('Checked');
  await expect(unreleased.getByTestId('radio-rt4d').getByTestId('checked-badge')).toHaveText(
    'Not checked yet',
  );
});

test('reading a radio is not held back as experimental; only the flash is, and it names the way out', async ({
  page,
}) => {
  await page.goto('?sim=1#mod17');
  await pickBuild(page);
  await enter(page);

  // A backup of a radio nobody has checked: no confirmation, and it works.
  const backup = step(page, 'step-backup');
  await expect(backup.getByTestId('needs-experimental')).toHaveCount(0);
  await Promise.all([page.waitForEvent('download'), backup.getByTestId('backup').click()]);
  await expect(page.getByTestId('backup-done')).toBeVisible({ timeout: 45_000 });
  expect(await page.evaluate(() => localStorage.getItem('ortx-flasher.experimental'))).toBeNull();
  await page.getByTestId('backup-continue').click();

  // The flash is where the page asks, with the tool that recovers the radio by name.
  const gate = step(page, 'step-flash').getByTestId('needs-experimental');
  await expect(gate).toBeVisible();
  await expect(page.getByTestId('flash')).toHaveCount(0);
  await expect(gate).toContainText('real Module 17');
  await expect(gate.getByTestId('recovery-tool')).toHaveText('dfu-util');
  await expect(gate.getByTestId('recovery-tool')).toHaveAttribute(
    'href',
    'https://dfu-util.sourceforge.net/',
  );
  await expect(gate).toContainText('you may prefer to wait until this model is checked');
  await turnOnExperimental(page);
  await expect(page.getByTestId('flash')).toBeEnabled();
});

test('a radio read through its original firmware is asked what it runs; "OpenRTX already" has nothing to read', async ({
  page,
}) => {
  await page.goto('?sim=1#mduv3x0');
  await pickBuild(page);
  const backup = step(page, 'step-backup');
  await expect(backup).toHaveAttribute('data-mode', 'open');

  // Asked first, with no answer assumed and nothing else to press.
  await expect(backup.getByTestId('runs-now')).toContainText('What does the radio run now?');
  await expect(backup.getByTestId('runs-original')).toHaveAttribute('aria-pressed', 'false');
  await expect(backup.getByTestId('runs-openrtx')).toHaveAttribute('aria-pressed', 'false');
  await expect(backup.getByTestId('backup')).toHaveCount(0);

  await answerRuns(page, 'original');
  await expect(backup.getByTestId('backup')).toBeVisible();

  // OpenRTX already: the read is gone, the reason is said, and going on is the one button.
  await answerRuns(page, 'openrtx');
  await expect(backup.getByTestId('backup')).toHaveCount(0);
  await expect(backup.getByTestId('backup-skip')).toHaveCount(0);
  await expect(backup.getByTestId('backup-runs-openrtx')).toContainText(
    'Nothing can be read through OpenRTX',
  );
  await expect.poll(() => background(backup.getByTestId('backup-continue'))).toBe(GOLD);
  await backup.getByTestId('backup-continue').click();
  await expect(backup).toContainText('not needed: runs OpenRTX · change');
  await expect(step(page, 'step-enter')).toHaveAttribute('data-mode', 'open');

  // The answer is for this model only.
  await page.getByTestId('open-step-radio').click();
  await page.getByTestId('radio-md3x0').click();
  await expect(step(page, 'step-backup').getByTestId('runs-openrtx')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});

test('upgrading a radio that runs OpenRTX is: radio, release, flashing mode, flash', async ({ page }) => {
  // The first visit: the answer is given once, and experimental flashing turned on once.
  await page.goto('?sim=1#mduv3x0');
  await pickBuild(page);
  await answerRuns(page, 'openrtx');
  await step(page, 'step-backup').getByTestId('backup-continue').click();
  await enter(page);
  await flash(page);

  // Every visit after: four choices, and the backup step is not in the way.
  await page.goto('?sim=1');
  await expect(page.getByTestId('radio-mduv3x0')).toBeVisible();
  await page.getByTestId('radio-mduv3x0').click();
  await page.getByTestId(`build-${release.id}`).click();
  await expect(step(page, 'step-enter')).toHaveAttribute('data-mode', 'open');
  await expect(step(page, 'step-backup')).toContainText('not needed: runs OpenRTX');
  await page.getByTestId('entered').click();
  await page.getByTestId('flash').click();
  await expect(page.getByTestId('done')).toBeVisible({ timeout: 45_000 });
  expect(await page.evaluate(() => window.__ortxSim!.radioId)).toBe('mduv3x0');

  // The answer can be taken back from the folded bar.
  await page.getByTestId('open-step-backup').click();
  await answerRuns(page, 'original');
  await expect(step(page, 'step-backup').getByTestId('backup')).toBeVisible();
});

test('"OpenRTX already" points at the backups this browser holds from before', async ({ page }) => {
  await page.goto('?sim=1#gd77');
  await pickBuild(page);
  await answerRuns(page, 'original');
  await Promise.all([page.waitForEvent('download'), page.getByTestId('backup').click()]);
  await expect(page.getByTestId('backup-done')).toBeVisible({ timeout: 60_000 });

  await page.reload();
  await pickBuild(page);
  await answerRuns(page, 'openrtx');
  const told = step(page, 'step-backup').getByTestId('backup-runs-openrtx');
  await expect(told.getByTestId('stored-count')).toContainText('1 backup of this model in this browser');
  await told.getByTestId('see-backups').click();
  await expect(page.getByTestId('stored-backup')).toBeInViewport();
});

test('a line before each button that opens the browser’s device list says which entry to pick', async ({
  page,
}) => {
  // USB, in flashing mode for both the backup and the flash.
  await page.goto('?sim=1#mod17');
  await pickBuild(page);
  await enter(page);
  const usbHint = step(page, 'step-backup').getByTestId('chooser-hint');
  await expect(usbHint).toContainText('Your browser will show a list of devices');
  await expect(usbHint).toContainText('“STM32 BOOTLOADER”');
  // The line comes before the button it is about.
  expect(
    await page.evaluate(() => {
      const hint = document.querySelector('#step-backup [data-testid="chooser-hint"]')!;
      return hint.compareDocumentPosition(document.querySelector('[data-testid="backup"]')!) & 4;
    }),
  ).toBe(4);
  await skipBackup(page);
  await turnOnExperimental(page);
  await expect(step(page, 'step-flash').getByTestId('chooser-hint')).toContainText('“STM32 BOOTLOADER”');

  // A serial port: told apart by unplugging the cable.
  await page.goto('?sim=1');
  await pickRadio(page, 'rt4d');
  await pickBuild(page);
  await answerRuns(page, 'original');
  await expect(step(page, 'step-backup').getByTestId('chooser-hint')).toContainText(
    'the entry that goes away when you unplug the cable',
  );
});

test('a device list closed without a pick is answered with "Radio not in the list?"', async ({ page }) => {
  await cancelEveryChooser(page);
  await page.goto('#mod17');
  await pickBuild(page);
  await enter(page);

  const backup = step(page, 'step-backup');
  await expect(backup.getByTestId('chooser-help')).toHaveCount(0);
  await backup.getByTestId('backup').click();
  const help = backup.getByTestId('chooser-help');
  await expect(help).toContainText('Radio not in the list?');
  await expect(help).toContainText('The cable carries data');
  await expect(help).toContainText('The radio is in flashing mode');
  await expect(help).toContainText('On Windows, the radio needs the WinUSB driver');
  await expect(help.getByTestId('zadig')).toHaveAttribute('href', 'https://zadig.akeo.ie');
  await expect(help.getByTestId('zadig')).toHaveAttribute('target', '_blank');
  await expect(help).toContainText('On Linux, your user needs permission for the device');
  // Closing the list is not a failure: nothing is reported as one.
  await expect(backup.getByTestId('backup-error')).toHaveCount(0);
  await expect(backup.getByTestId('backup')).toHaveText('Back up now');

  // The same in the flash step.
  await skipBackup(page);
  await turnOnExperimental(page);
  const flashStep = step(page, 'step-flash');
  await flashStep.getByTestId('flash').click();
  await expect(flashStep.getByTestId('chooser-help')).toContainText('Radio not in the list?');
  await expect(flashStep.getByTestId('flash-error')).toHaveCount(0);
  await expect(flashStep.getByTestId('flash')).toHaveText('Connect and flash');
});

test('a radio read in normal mode gets the checklist for that: normal mode, and no USB driver for a serial cable', async ({
  page,
}) => {
  await cancelEveryChooser(page);
  await page.goto('');
  await pickRadio(page, 'rt4d');
  await pickBuild(page);
  await answerRuns(page, 'original');
  await page.getByTestId('backup').click();
  const help = step(page, 'step-backup').getByTestId('chooser-help');
  await expect(help).toContainText('switched on in normal mode');
  await expect(help).toContainText('answer “OpenRTX already” above');
  await expect(help).toContainText('membership of the dialout group');
  await expect(help.getByTestId('zadig')).toHaveCount(0);
});

test('after a flash the page says what comes next, and "Flash another" starts over for a new radio', async ({
  page,
}) => {
  await page.goto('?sim=1#mod17');
  await pickBuild(page);
  await enter(page);
  await skipBackup(page);
  await flash(page);
  expect(await page.evaluate(() => window.__ortxSimPicks)).toBe(1);

  const flashStep = step(page, 'step-flash');
  // What to do and what to expect, the guide, and what to do if it does not start.
  await expect(flashStep.getByTestId('after')).toContainText('Press reset');
  await expect(flashStep.getByTestId('after')).toContainText('It should start OpenRTX');
  await expect(flashStep.getByTestId('after-guide')).toHaveAttribute('href', /\/user_guide\/$/);
  await expect(flashStep.getByTestId('if-not-starting')).toContainText('put it in flashing mode again');
  await expect(flashStep.getByTestId('if-not-starting')).toContainText('manufacturer’s firmware');
  await expect(
    flashStep.getByTestId('if-not-starting').getByRole('link', { name: 'dfu-util' }),
  ).toBeVisible();

  // "Flash again" is still there, but it is no longer the gold button.
  await expect(flashStep.getByTestId('flash')).toHaveText('Flash again');
  await expect.poll(() => background(flashStep.getByTestId('flash'))).not.toBe(GOLD);
  await expect(flashStep.getByTestId('flash-another')).toHaveText('Flash another Module 17');

  // A second radio: its backup and its flashing mode are asked for again.
  await flashStep.getByTestId('flash-another').click();
  await expect(step(page, 'step-enter')).toHaveAttribute('data-mode', 'open');
  await expect(step(page, 'step-backup')).toHaveAttribute('data-mode', 'waiting');
  await expect(step(page, 'step-backup')).not.toContainText('skipped');
  await expect(step(page, 'step-flash')).toHaveAttribute('data-mode', 'waiting');
  // The radio model and the firmware stay.
  await expect(step(page, 'step-radio')).toContainText('Module 17');
  await expect(step(page, 'step-firmware')).toHaveAttribute('data-mode', 'folded');

  await enter(page);
  await skipBackup(page);
  await expect(flashStep.getByTestId('done')).toHaveCount(0);
  await expect(flashStep.getByTestId('flash')).toHaveText('Connect and flash');
  await expect.poll(() => background(flashStep.getByTestId('flash'))).toBe(GOLD);
  // The browser is asked for the device again: it is another radio.
  await flashStep.getByTestId('flash').click();
  await expect(page.getByTestId('done')).toBeVisible({ timeout: 45_000 });
  expect(await page.evaluate(() => window.__ortxSimPicks)).toBe(2);
});

test('a failed flash says whether the radio was written, offers "Try again", and puts the checklist before the report', async ({
  page,
}) => {
  await page.goto('?sim=fail#mod17');
  await pickBuild(page);
  await skipToFlash(page);
  const flashStep = step(page, 'step-flash');
  await flashStep.getByTestId('flash').click();

  const error = flashStep.getByTestId('flash-error');
  await expect(error).toContainText('did not answer');
  await expect(error.getByTestId('flash-wrote')).toHaveText('Nothing was written to the radio.');
  // No sentence of the page's own is added to the flasher's: the remedy is said once.
  expect((await error.innerText()).match(/try again/gi) ?? []).toHaveLength(0);
  await expect(flashStep.getByTestId('flash')).toHaveText('Try again');

  // What to check comes first; the report is behind it, folded.
  const more = flashStep.getByTestId('still-failing');
  await expect(more).not.toHaveAttribute('open', '');
  await expect(more.getByTestId('report-failed')).toBeHidden();
  await more.locator('summary').click();
  await expect(more.getByTestId('checks')).toContainText('The cable carries data');
  await expect(more.getByTestId('report-failed')).toHaveText('Report this');
  expect(
    await more.evaluate((box) => {
      const checks = box.querySelector('[data-testid="checks"]')!;
      return checks.compareDocumentPosition(box.querySelector('[data-testid="report-failed"]')!) & 4;
    }),
  ).toBe(4);
});

test('a failed backup says that reading changes nothing on the radio', async ({ page }) => {
  await page.goto('?sim=fail#mod17');
  await pickBuild(page);
  await enter(page);
  const backup = step(page, 'step-backup');
  await backup.getByTestId('backup').click();
  await expect(backup.getByTestId('backup-error')).toBeVisible();
  await expect(backup.getByTestId('backup-untouched')).toHaveText('Reading changes nothing on the radio.');
  await expect(backup.getByTestId('backup')).toHaveText('Try again');
  await expect(backup.getByTestId('still-failing').getByTestId('report-failed')).toBeHidden();
});

test('a flasher that already says nothing was sent is not repeated by the page', async ({ page }) => {
  await page.goto('?sim=wrongmode#md3x0');
  await pickBuild(page);
  await answerRuns(page, 'original');

  // The backup fails: reading changes nothing, and the page says so.
  const backup = step(page, 'step-backup');
  await backup.getByTestId('backup').click();
  await expect(backup.getByTestId('backup-error')).toContainText('The radio is in flashing mode');
  await expect(backup.getByTestId('backup-error')).toContainText('Nothing was sent to it.');
  await expect(backup.getByTestId('backup-untouched')).toHaveCount(0);
  await expect(backup.getByTestId('backup')).toHaveText('Try again');
  expect((await backup.getByTestId('backup-error').innerText()).match(/normal mode/g)).toHaveLength(1);

  await skipBackup(page);
  await enter(page);
  await turnOnExperimental(page);
  await page.getByTestId('flash').click();
  const error = step(page, 'step-flash').getByTestId('flash-error');
  await expect(error).toContainText('Nothing was sent to it.');
  await expect(error.getByTestId('flash-wrote')).toHaveCount(0);
  expect((await error.innerText()).match(/try again/gi)).toHaveLength(1);
});

test('leaving the page while a radio is written asks first, and every link opens in a new tab', async ({
  page,
}) => {
  /** Whether the page would hold the reader back from leaving right now. */
  const asksBeforeLeaving = () =>
    page.evaluate(() => {
      const leaving = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(leaving);
      return leaving.defaultPrevented;
    });

  await page.goto('?sim=slow#mod17');
  await pickBuild(page);
  await skipToFlash(page);
  expect(await asksBeforeLeaving()).toBe(false);

  await page.getByTestId('flash').click();
  await expect(page.getByTestId('flash').getByTestId('spinner')).toBeVisible();
  await expect.poll(asksBeforeLeaving).toBe(true);
  // Every link of the flasher that leaves the page does so in a new tab; the others
  // save a file or stay on the page.
  const sameTab = await page
    .getByTestId('flasher')
    .evaluate((flasher) =>
      [...flasher.querySelectorAll('a[href]')]
        .filter((a) => a.getAttribute('target') !== '_blank' && !a.hasAttribute('download'))
        .map((a) => a.getAttribute('href')),
    );
  expect(sameTab).toEqual([]);
  expect(await page.getByTestId('flasher').locator('a[target="_blank"]').count()).toBeGreaterThan(3);

  await expect(page.getByTestId('done')).toBeVisible({ timeout: 60_000 });
  await expect.poll(asksBeforeLeaving).toBe(false);
});

test('leaving the page while a radio is read asks first too', async ({ page }) => {
  await page.goto('?sim=slow#mod17');
  await pickBuild(page);
  await enter(page);
  await page.getByTestId('backup').click();
  await expect(page.getByTestId('backup').getByTestId('spinner')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const leaving = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(leaving);
        return leaving.defaultPrevented;
      }),
    )
    .toBe(true);
});

test('the current release is marked as recommended and links its release notes', async ({ page }) => {
  await page.goto('#mduv3x0');
  const tiles = page.getByTestId('builds');
  await expect(tiles.getByText('Recommended')).toHaveCount(1);
  // The word is on the release's card, not on the development build's.
  await expect(tiles.locator('.card', { has: page.getByTestId(`build-${release.id}`) })).toContainText(
    'Recommended',
  );
  const notes = tiles.getByTestId('release-notes');
  await expect(notes).toHaveAttribute('href', release.url);
  await expect(notes).toHaveAttribute('target', '_blank');
  // A link next to the choice, not inside it: following it chooses nothing.
  await expect(page.getByTestId(`build-${release.id}`).locator('a')).toHaveCount(0);
  await expect(step(page, 'step-firmware')).toHaveAttribute('data-mode', 'open');

  // A radio without a release has no recommendation to make.
  await page.goto('#md9600');
  await page.reload();
  await expect(page.getByTestId('builds')).toBeVisible();
  await expect(page.getByTestId('builds').getByText('Recommended')).toHaveCount(0);
});

test('a chosen build keeps its commit, date, time and run in sight: bar, flash step, done line, console, report', async ({
  page,
}) => {
  const commit = master.sha!.slice(0, 7);
  await page.goto('?sim=1#mod17');
  // The tile says when, to the minute.
  await expect(page.getByTestId(`build-${master.id}`)).toContainText(shown(master.date));
  await page.getByTestId(`build-${master.id}`).click();

  // The folded bar.
  const bar = step(page, 'step-firmware').getByTestId('chosen-build');
  await expect(bar).toBeVisible();
  await expect(bar).toContainText(`commit ${commit}`);
  await expect(bar).toContainText(shown(master.date));
  await expect(bar.getByTestId('build-page')).toHaveText('CI run');
  await expect(bar.getByTestId('build-page')).toHaveAttribute('href', master.url);

  // The flash step.
  await skipToFlash(page);
  const facts = step(page, 'step-flash').getByTestId('flash-build');
  await expect(facts).toContainText(`commit ${commit}`);
  await expect(facts).toContainText(shown(master.date));
  await expect(facts.getByTestId('build-page')).toHaveAttribute('href', master.url);

  // The done line and the console.
  await flash(page);
  const flashStep = step(page, 'step-flash');
  await expect(flashStep.getByTestId('done-build')).toContainText(`master, commit ${commit}`);
  await expect(flashStep.getByTestId('done-build')).toContainText(shown(master.date));
  await flashStep.getByTestId('console').locator('summary').click();
  await expect(flashStep.getByTestId('log')).toContainText(`Firmware: master, commit ${commit}`);
  await expect(flashStep.getByTestId('log')).toContainText(`From: ${master.url}`);

  // The report: the whole commit, the time without a time zone to guess, and the run.
  const body = new URL((await flashStep.getByTestId('report-worked').getAttribute('href'))!).searchParams.get(
    'body',
  )!;
  expect(body).toContain(`commit ${master.sha!}`);
  expect(body).toContain(`dated ${master.date}`);
  expect(body).toContain(master.url);

  // A release has no commit in its listing; its date, time and notes are kept the same way.
  await page.getByTestId('open-step-firmware').click();
  await page.getByTestId(`build-${release.id}`).click();
  await expect(bar).toContainText(shown(release.date));
  await expect(bar.getByTestId('build-page')).toHaveText('Release notes');
  await expect(bar.getByTestId('build-page')).toHaveAttribute('href', release.url);
});

test('a dropped CI zip must be the one that was looked up: another build’s zip is refused', async ({
  page,
}) => {
  const right = mod17Zip(0x11);
  const other = mod17Zip(0x22);
  await fakePullRequest(page, {
    size_in_bytes: right.length,
    digest: `sha256:${createHash('sha256').update(right).digest('hex')}`,
  });
  await page.goto('?sim=1#mod17');
  await page.getByTestId('open-other').click();
  await page.getByTestId('open-ci').click();
  await page.getByTestId('ci-ref').fill('#588');
  await page.getByTestId('ci-find').click();
  // What was found is named by commit and time before anything is downloaded.
  await expect(page.getByTestId('ci-result')).toContainText('commit feedc0d');
  await expect(page.getByTestId('ci-result')).toContainText(shown('2026-11-20T02:05:00Z'));

  // The zip of some other build: same name, same shape, other bytes.
  const input = page.getByTestId('ci-panel').getByTestId('file-input');
  await input.setInputFiles({ name: 'openrtx-mod17.zip', mimeType: 'application/zip', buffer: other });
  const error = page.getByTestId('ci-error');
  await expect(error).toContainText('openrtx-mod17.zip is not the zip of PR #588');
  await expect(error).toContainText('SHA-256');
  await expect(error).toContainText('It was not loaded');
  await expect(page.getByTestId('loaded')).toHaveCount(0);
  await expect(step(page, 'step-firmware')).toHaveAttribute('data-mode', 'open');
  await expect(step(page, 'step-enter')).toHaveAttribute('data-mode', 'waiting');

  // The right one is taken, and the page says it was checked.
  await input.setInputFiles({ name: 'openrtx-mod17.zip', mimeType: 'application/zip', buffer: right });
  await expect(step(page, 'step-firmware')).toHaveAttribute('data-mode', 'folded');
  await page.getByTestId('open-step-firmware').click();
  await expect(page.getByTestId('ci-error')).toHaveCount(0);
  await expect(page.getByTestId('ci-checked')).toContainText('this is the zip GitHub lists for the build');
});

test('a CI zip GitHub lists no checksum for is taken, and the page says it could not be checked', async ({
  page,
}) => {
  const zip = mod17Zip(0x33);
  await fakePullRequest(page, { size_in_bytes: zip.length });
  await page.goto('?sim=1#mod17');
  await lookUpAndDrop(page, zip);
  await expect(step(page, 'step-firmware')).toHaveAttribute('data-mode', 'folded');
  await page.getByTestId('open-step-firmware').click();
  await expect(page.getByTestId('loaded')).toContainText('PR #588');
  await expect(page.getByTestId('ci-unchecked')).toContainText('Could not be checked');
  await expect(page.getByTestId('ci-checked')).toHaveCount(0);
});

test('the address carries the radio, and a changed address changes the radio', async ({ page }) => {
  await page.goto('#md3x0');
  await expect(step(page, 'step-radio')).toContainText('Tytera MD-380');
  await page.evaluate(() => (location.hash = '#gd77'));
  await expect(step(page, 'step-radio')).toContainText('Radioddity GD-77');
  await expect(step(page, 'step-firmware')).toHaveAttribute('data-mode', 'open');
  // Picking by hand writes the address; going back in history picks again.
  await page.getByTestId('open-step-radio').click();
  await page.getByTestId('radio-mod17').click();
  await expect(page).toHaveURL(/#mod17$/);
  await page.evaluate(() => (location.hash = '#cs7000'));
  await expect(step(page, 'step-radio')).toContainText('Connect Systems CS7000-M17');
  await page.goBack();
  await expect(step(page, 'step-radio')).toContainText('Module 17');
  // An address that names no radio leaves the choice alone.
  await page.evaluate(() => (location.hash = '#nothing'));
  await expect(step(page, 'step-radio')).toContainText('Module 17');
});

test('the page remembers what it last flashed, per radio, and says when the same build is chosen again', async ({
  page,
}) => {
  await page.goto('?sim=1#mod17');
  await expect(page.getByTestId('last-flashed')).toHaveCount(0);
  await page.getByTestId(`build-${release.id}`).click();
  await enter(page);
  await Promise.all([page.waitForEvent('download'), page.getByTestId('backup').click()]);
  await expect(page.getByTestId('backup-done')).toBeVisible({ timeout: 45_000 });
  await page.getByTestId('backup-continue').click();
  await expect(page.getByTestId('same-build')).toHaveCount(0);
  await flash(page);

  // On the row of the backup of that very radio.
  await expect(page.getByTestId('stored-backup').getByTestId('stored-flashed')).toContainText(
    `Last flashed here: ${release.label}`,
  );

  // On the next visit, at the firmware step; and choosing the same release again says so.
  await page.reload();
  await expect(page.getByTestId('last-flashed')).toContainText(
    `Last flashed here onto a Module 17: ${release.label}`,
  );
  await page.getByTestId(`build-${release.id}`).click();
  await skipToFlash(page);
  await expect(page.getByTestId('same-build')).toContainText(
    `${release.label} is what this browser last flashed`,
  );
  // Another build is not the same one.
  await page.getByTestId('open-step-firmware').click();
  await page.getByTestId(`build-${master.id}`).click();
  await expect(page.getByTestId('flash')).toBeVisible();
  await expect(page.getByTestId('same-build')).toHaveCount(0);
});

test('a pull request GitHub does not have is named with its repository', async ({ page }) => {
  await page.route('https://api.github.com/repos/OpenRTX/OpenRTX/pulls/99999', (r) =>
    r.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
  );
  await page.goto('?sim=1#mod17');
  await page.getByTestId('open-other').click();
  await page.getByTestId('open-ci').click();
  await page.getByTestId('ci-ref').fill('#99999');
  await page.getByTestId('ci-find').click();
  await expect(page.getByTestId('ci-error')).toHaveText(
    'GitHub does not know pull request #99999 in OpenRTX/OpenRTX.',
  );
});

test.describe('on a phone-sized screen', () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test('the page holds together: nothing wider than the screen, and folded bars do not collide', async ({
    page,
  }) => {
    /** Checks the page as it is now. */
    const holdsTogether = async () => {
      const report = await page.evaluate(() => {
        const problems: string[] = [];
        const root = document.documentElement;
        if (root.scrollWidth > root.clientWidth) {
          problems.push(`the page is ${root.scrollWidth}px wide on a ${root.clientWidth}px screen`);
        }
        for (const section of document.querySelectorAll('[data-testid="step"][data-mode="folded"]')) {
          const title = section.querySelector(`#${section.id}-title`)!.getBoundingClientRect();
          const state = section.querySelector('[data-testid="step-state"]')!;
          const box = state.getBoundingClientRect();
          const overlap = box.width > 0 && title.right > box.left && title.left < box.right;
          if (overlap && title.bottom > box.top && title.top < box.bottom) {
            problems.push(`${section.id}: the title and the state overlap`);
          }
          if (state.scrollWidth > state.clientWidth) problems.push(`${section.id}: the state is cut off`);
        }
        return problems;
      });
      expect(report).toEqual([]);
    };

    await page.goto('?sim=1');
    await expect(page.getByTestId('radio-md3x0')).toBeVisible();
    await holdsTogether();
    await page.getByTestId('radio-mduv3x0').click();
    await expect(page.getByTestId('builds')).toBeVisible();
    await holdsTogether();
    // The longest radio name there is, whole, on a bar that says how to change it.
    await expect(step(page, 'step-radio').getByTestId('step-state')).toHaveText('Tytera MD-UV380 / MD-UV390');
    await expect(page.getByTestId('open-step-radio')).toContainText('change');
    await pickBuild(page);
    await holdsTogether();
    await answerRuns(page, 'original');
    await holdsTogether();
    await skipBackup(page);
    await holdsTogether();
    await enter(page);
    await holdsTogether();
    await flash(page);
    await holdsTogether();
  });
});
