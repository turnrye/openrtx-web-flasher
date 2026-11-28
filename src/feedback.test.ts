// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  asksForSuccess,
  MAX_URL_LENGTH,
  reportBody,
  reportTitle,
  reportUrl,
  scrubLog,
  type Report,
} from './feedback.ts';

const BASE = 'https://example.org/owner/repo/issues/new';

/** A report of a failed flash with a log. */
function failed(log: string[]): Report {
  return {
    outcome: 'failed',
    step: 'flash',
    radio: { id: 'mduv3x0', name: 'Tytera MD-UV380 / MD-UV390' },
    firmware: { label: 'v0.4.5', file: 'openrtx_mduv3x0_v0.4.5.bin', sha256: 'ab'.repeat(32) },
    backup: 'saved, complete',
    error: 'The radio did not answer.',
    log,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/142.0',
    buildId: 'abc1234',
  };
}

/** The title and body a link would fill in. */
function parse(url: string): { title: string; body: string } {
  const query = new URL(url).searchParams;
  return { title: query.get('title')!, body: query.get('body')! };
}

describe('feedback reports', () => {
  it('only asks for successes while a radio is unchecked', () => {
    expect(asksForSuccess(false)).toBe(true);
    expect(asksForSuccess(true)).toBe(false);
  });

  it('says what happened to which radio, with what, in which browser and build', () => {
    const report = failed(['Erasing 0x0800C000, 16384 bytes.', 'Failed: The radio did not answer.']);
    expect(reportTitle(report)).toBe('Failed: Tytera MD-UV380 / MD-UV390, flash');
    const body = reportBody(report);
    expect(body).toContain('**Result:** flash failed');
    expect(body).toContain('**Radio:** Tytera MD-UV380 / MD-UV390 (mduv3x0)');
    expect(body).toContain(`**Firmware:** v0.4.5, openrtx_mduv3x0_v0.4.5.bin, SHA-256 ${'ab'.repeat(32)}`);
    expect(body).toContain('**Backup:** saved, complete');
    expect(body).toContain('**Message:** The radio did not answer.');
    expect(body).toContain('**Browser:** Mozilla/5.0 (X11; Linux x86_64) Chrome/142.0');
    expect(body).toContain('**Flasher build:** abc1234');
    expect(body).toContain('Erasing 0x0800C000, 16384 bytes.');

    const worked: Report = { ...report, outcome: 'worked', error: undefined };
    expect(reportTitle(worked)).toBe('Worked: Tytera MD-UV380 / MD-UV390 with v0.4.5');
    expect(reportBody(worked)).toContain('**Result:** the radio started OpenRTX');
  });

  it('names a file given by hand once', () => {
    const file = 'openrtx_md9600_chip-modem-242dcee0_wrap.bin';
    const report: Report = { ...failed([]), firmware: { label: file, file, sha256: 'cd'.repeat(32) } };
    expect(reportBody(report)).toContain(`**Firmware:** ${file}, SHA-256 ${'cd'.repeat(32)}\n`);
  });

  it('names the build by its commit, its date and its page, when the build has them', () => {
    const report: Report = {
      ...failed([]),
      firmware: {
        label: 'PR #588',
        file: 'openrtx_mduv3x0_fix.bin',
        sha256: 'ef'.repeat(32),
        commit: 'feedc0de'.repeat(5),
        date: '2026-11-20T02:05:00Z',
        url: 'https://github.com/OpenRTX/OpenRTX/actions/runs/77',
      },
    };
    expect(reportBody(report)).toContain(
      `**Firmware:** PR #588, openrtx_mduv3x0_fix.bin, commit ${'feedc0de'.repeat(5)}, ` +
        'dated 2026-11-20T02:05:00Z, https://github.com/OpenRTX/OpenRTX/actions/runs/77, ' +
        `SHA-256 ${'ef'.repeat(32)}\n`,
    );
    // The commit is a fact about the build, not about one radio: it is not scrubbed.
    expect(reportBody(report)).not.toContain('[removed]');
  });

  it('keeps anything that identifies one radio out of the log', () => {
    const log = scrubLog([
      'chip-id: C620240900065701',
      'Reading 0x08000000, 1024 bytes.',
      'The radio answered bbbcb892ac5bdc20784198de where 06 was expected.',
      'USB serial number 3559355A3432',
    ]);
    expect(log).toEqual([
      'Reading 0x08000000, 1024 bytes.',
      'The radio answered [removed] where 06 was expected.',
    ]);
    const body = reportBody(failed(['chip-id: C620240900065701', 'Done.']));
    expect(body).not.toContain('C620240900065701');
    expect(body).toContain('Done.');
  });

  it('makes a link both forges fill in, from title and body alone', () => {
    const url = reportUrl(BASE, failed(['one', 'two']));
    expect(url.startsWith(`${BASE}?title=`)).toBe(true);
    expect([...new URL(url).searchParams.keys()]).toEqual(['title', 'body']);
    expect(parse(url).title).toBe('Failed: Tytera MD-UV380 / MD-UV390, flash');
    expect(parse(url).body).toContain('two');
    // A base that already has a query keeps it.
    expect(reportUrl(`${BASE}?project=1`, failed([]))).toContain('issues/new?project=1&title=');
  });

  it('cuts a long log from its start so the link stays short enough', () => {
    const log = Array.from(
      { length: 2000 },
      (_, i) => `Writing block ${i} of 2000 at 0x${(i * 1024).toString(16)}.`,
    );
    const url = reportUrl(BASE, failed(log));
    expect(url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
    const { body } = parse(url);
    expect(body).toContain('Writing block 1999 of 2000');
    expect(body).not.toContain('Writing block 0 of 2000');
    expect(body).toMatch(/Log \(last \d+ of 2000 lines\):/);
    // The copied report has all of it.
    expect(reportBody(failed(log))).toContain('Writing block 0 of 2000');
  });

  it('still fits when the message itself is enormous', () => {
    const report = { ...failed(['x']), error: 'E'.repeat(20000) };
    expect(reportUrl(BASE, report).length).toBeLessThanOrEqual(MAX_URL_LENGTH);
  });

  it('a suggestion carries only the browser and the build', () => {
    const report: Report = { outcome: 'suggestion', userAgent: 'UA', buildId: 'abc1234' };
    expect(reportTitle(report)).toBe('Feedback: ');
    const body = reportBody(report);
    expect(body).toContain('What would you change?');
    expect(body).not.toContain('Result');
    expect(body).not.toContain('Radio');
  });
});
