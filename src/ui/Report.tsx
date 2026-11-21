// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The two ways a report leaves the page: a link that opens the issue tracker with the
 * report filled in, and a button that copies it. Neither sends anything by itself.
 */
import { useState } from 'preact/hooks';
import { reportBody, reportTitle, reportUrl, type Report } from '../feedback.ts';

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
      class={props.plain ? undefined : 'btn'}
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
    <button class="linkish" type="button" data-testid="copy-report" onClick={() => void copy()}>
      {said || 'Copy report'}
    </button>
  );
}

/** The line under report links that says what happens when one is followed. */
export function ReportNote() {
  return (
    <p class="muted small">
      The report opens on the project’s issue tracker, where you can read and change it before you send it. It
      is public once sent. The page sends nothing by itself.
    </p>
  );
}
