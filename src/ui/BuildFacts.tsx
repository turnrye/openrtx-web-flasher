// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What tells one build from another once it is chosen: the commit it was made from, when
 * it was made, and its page (the release notes or the CI run). The page keeps these in
 * sight from the choice to the report, so nobody has to trust a label like "master".
 */
import type { Build } from '../firmware/builds.ts';
import { formatDateTime, Out } from './common.tsx';

/** The first seven characters of a commit, as GitHub shortens it. */
export function shortCommit(sha: string): string {
  return sha.slice(0, 7);
}

/** What happened at a build's date: a release was published, a backup taken, a build made. */
function verb(build: Build): string {
  return build.backup ? 'taken' : build.kind === 'release' ? 'released' : 'built';
}

/** What a build's page is called on a link. */
function pageName(build: Build): string {
  return build.kind === 'release' ? 'Release notes' : 'CI run';
}

/** The facts as words: "commit fa09ad4", "built 25 Nov 2026, 11:20". Empty for a file with neither. */
export function buildFacts(build: Build): string[] {
  return [
    build.sha ? `commit ${shortCommit(build.sha)}` : '',
    build.date ? `${verb(build)} ${formatDateTime(build.date)}` : '',
  ].filter(Boolean);
}

/** One line for the log and for sentences: "PR #588, commit feedc0d, built 20 Nov 2026, 02:00". */
export function describeBuild(build: Build): string {
  return [build.label, ...buildFacts(build)].join(', ');
}

/** The facts and the link to the build's page; nothing for a build that has neither. */
export function BuildFacts({ build, testid }: { build: Build; testid?: string }) {
  const facts = buildFacts(build);
  if (facts.length === 0 && !build.url) return null;
  return (
    <span data-testid={testid}>
      {facts.join(' · ')}
      {build.url && (
        <>
          {facts.length > 0 && ' · '}
          <Out href={build.url} testid="build-page">
            {pageName(build)}
          </Out>
        </>
      )}
    </span>
  );
}
