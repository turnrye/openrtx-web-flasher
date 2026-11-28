// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Reports people can send about a flash or a backup.
 *
 * The page sends nothing by itself. It builds a link to the issue tracker's "new issue"
 * page with the report already filled in; the person reads it there and submits it, or
 * copies the report and takes it somewhere else. Trackers are public, so a report holds
 * nothing that identifies one radio: no radio ID, nothing out of a backup.
 *
 * The link uses only `title` and `body`, which GitHub and Forgejo both fill in.
 */

/** What a report says happened. */
export type Outcome = 'worked' | 'failed' | 'suggestion';

/** Everything a report can carry. */
export interface Report {
  outcome: Outcome;
  /** The step the report is about. */
  step?: 'flash' | 'backup';
  radio?: { id: string; name: string };
  firmware?: {
    label: string;
    file: string;
    sha256: string;
    /** The commit the build was made from, when the build says. */
    commit?: string;
    /** The build's date as the build gives it (made, or released), ISO 8601. */
    date?: string;
    /** The build's release page or CI run. */
    url?: string;
  };
  /** How the backup step ended, in a few words: "saved, complete", "skipped". */
  backup?: string;
  /** The message the page showed. */
  error?: string;
  /** What the page logged, oldest line first. */
  log?: string[];
  /** The browser's user agent string. */
  userAgent: string;
  /** The commit this copy of the page was built from. */
  buildId: string;
}

/** Longest link the page makes. Trackers answer a link that is too long with an error page. */
export const MAX_URL_LENGTH = 6000;

/**
 * Whether to ask for a "it worked" report. Once a radio is marked as checked on
 * hardware, more successes say nothing new, so the page only offers to report a problem.
 */
export function asksForSuccess(verified: boolean): boolean {
  return !verified;
}

/**
 * Takes out of a log whatever could identify one radio: lines that report an ID, and
 * long runs of hexadecimal digits anywhere else.
 */
export function scrubLog(lines: string[]): string[] {
  return lines
    .filter((line) => !/chip[- ]?id|serial number|\buid\b/i.test(line))
    .map((line) => line.replace(/\b[0-9a-f]{16,}\b/gi, '[removed]'));
}

/** The issue title: what happened, to which radio. */
export function reportTitle(report: Report): string {
  if (report.outcome === 'suggestion') return 'Feedback: ';
  const radio = report.radio?.name ?? 'radio';
  if (report.outcome === 'worked') {
    return `Worked: ${radio}${report.firmware ? ` with ${report.firmware.label}` : ''}`;
  }
  return `Failed: ${radio}, ${report.step ?? 'flash'}`;
}

/**
 * The report as text. `logLines` limits the log to its last lines; left out, all of it
 * is included.
 */
export function reportBody(report: Report, logLines?: number): string {
  const lines: string[] = [];
  const add = (label: string, value: string | undefined) => {
    if (value) lines.push(`**${label}:** ${value}`);
  };
  if (report.outcome !== 'suggestion') {
    add(
      'Result',
      report.outcome === 'worked' ? 'the radio started OpenRTX' : `${report.step ?? 'flash'} failed`,
    );
  }
  add('Radio', report.radio && `${report.radio.name} (${report.radio.id})`);
  add(
    'Firmware',
    report.firmware &&
      [
        report.firmware.label,
        // A file given by hand is labelled with its own name
        report.firmware.file !== report.firmware.label ? report.firmware.file : undefined,
        report.firmware.commit && `commit ${report.firmware.commit}`,
        report.firmware.date && `dated ${report.firmware.date}`,
        report.firmware.url,
        `SHA-256 ${report.firmware.sha256}`,
      ]
        .filter(Boolean)
        .join(', '),
  );
  add('Backup', report.backup);
  add('Message', report.error);
  add('Browser', report.userAgent);
  add('Flasher build', report.buildId);
  lines.push('', report.outcome === 'suggestion' ? 'What would you change?' : 'Anything to add:', '', '');

  const log = scrubLog(report.log ?? []);
  if (log.length > 0 && logLines !== 0) {
    const kept = logLines === undefined ? log : log.slice(-logLines);
    const cut = kept.length < log.length;
    lines.push(cut ? `Log (last ${kept.length} of ${log.length} lines):` : 'Log:', '', '```', ...kept, '```');
  }
  return lines.join('\n');
}

/**
 * The link that opens the tracker's new-issue page with the report filled in. The log is
 * cut from its start until the link is short enough.
 */
export function reportUrl(base: string, report: Report): string {
  const link = (body: string) =>
    `${base}${base.includes('?') ? '&' : '?'}title=${encodeURIComponent(reportTitle(report))}&body=${encodeURIComponent(body)}`;
  let keep = scrubLog(report.log ?? []).length;
  let url = link(reportBody(report, keep));
  while (url.length > MAX_URL_LENGTH && keep > 0) {
    keep = Math.floor(keep * 0.7);
    url = link(reportBody(report, keep));
  }
  if (url.length > MAX_URL_LENGTH && report.error) {
    // A very long message: keep its start.
    url = link(reportBody({ ...report, error: `${report.error.slice(0, 300)}…` }, 0));
  }
  return url;
}
