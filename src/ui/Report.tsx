// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The two ways a report leaves the page: a link that opens the issue tracker with the
 * report filled in, and a button that copies it. Neither sends anything by itself.
 */
import { useState } from 'preact/hooks';
import { reportBody, reportTitle, reportUrl, type Report } from '../feedback.ts';
import type { Purpose } from '../flash/run.ts';
import type { Radio } from '../radios.ts';
import { Checks } from './Chooser.tsx';

/** A report without the two things every report gets from the page itself. */
export type ReportDraft = Omit<Report, 'userAgent' | 'buildId'>;

/** Adds the browser and the build of the page to a draft. */
function complete(draft: ReportDraft): Report {
  return { ...draft, userAgent: navigator.userAgent, buildId: __BUILD_ID__ };
}

/** A link to the tracker's new-issue page with `report` filled in, in a new tab. */
export function ReportLink(props: { report: ReportDraft; label: string; testid: string; plain?: boolean }) {
  return (
    <a
      class={props.plain ? 'link link-primary' : 'btn btn-sm'}
      href={reportUrl(__FEEDBACK_URL__, complete(props.report))}
      target="_blank"
      rel="noopener noreferrer"
      data-testid={props.testid}
    >
      {props.label}
    </a>
  );
}

/** A button that copies the whole report, with all of its log, to paste somewhere else. */
export function CopyReport({ report }: { report: ReportDraft }) {
  const [said, setSaid] = useState('');
  const copy = async () => {
    const full = complete(report);
    try {
      await navigator.clipboard.writeText(`${reportTitle(full)}\n\n${reportBody(full)}`);
      setSaid('Copied');
    } catch {
      setSaid('This browser would not copy it');
    }
  };
  return (
    <button class="btn btn-ghost btn-sm" type="button" data-testid="copy-report" onClick={() => void copy()}>
      {said || 'Copy report'}
    </button>
  );
}

/** The line under report links that says what happens when one is followed. */
export function ReportNote() {
  return (
    <p class="text-sm text-muted">
      The report opens on the project’s issue tracker, where you can read and change it before you send it. It
      is public once sent. The page sends nothing by itself.
    </p>
  );
}

/**
 * What follows a failed read or write, after the message and the button to try again:
 * first what to check, then the report. Most failures are a cable or a mode, and those
 * are not worth an issue.
 */
export function StillFailing(props: { radio: Radio; purpose: Purpose; report: ReportDraft }) {
  return (
    <details class="collapse-arrow collapse border border-separator" data-testid="still-failing">
      <summary class="collapse-title min-h-0 py-2 text-sm">
        Still failing? What to check, and how to report it
      </summary>
      <div class="collapse-content flex flex-col gap-3">
        <Checks radio={props.radio} purpose={props.purpose} />
        <div class="flex flex-wrap items-center gap-2">
          <ReportLink report={props.report} label="Report this" testid="report-failed" />
          <CopyReport report={props.report} />
        </div>
        <ReportNote />
      </div>
    </details>
  );
}
