#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Publishes the built site to a branch that a Pages host serves. The branch holds the
# main site at its root and one folder per open pull request:
#
#   /                      the site built from main
#   /pr-preview/pr-12/     the site built from pull request 12
#
# The branch is rewritten as one commit on every publish (see below), so it must not be
# used for anything else.
#
# Usage:
#   ci/publish-pages-branch.sh site <dir>           replace the main site with <dir>
#   ci/publish-pages-branch.sh preview <n> <dir>    publish <dir> as the preview of PR <n>
#   ci/publish-pages-branch.sh remove <n>           delete the preview of PR <n>
#
# Works the same on GitHub and Forgejo: both runners set GITHUB_SERVER_URL,
# GITHUB_REPOSITORY and GITHUB_TOKEN. Environment:
#   PAGES_BRANCH   branch to publish to (default gh-pages)
#   PAGES_REMOTE   git URL to push to (default: this repository, with GITHUB_TOKEN)
#   PAGES_CHECKOUT where to leave the checked-out branch (default: a temp dir, removed)
set -euo pipefail

mode="${1:?site, preview or remove}"
branch="${PAGES_BRANCH:-gh-pages}"
if [ -z "${PAGES_REMOTE:-}" ]; then
  : "${GITHUB_SERVER_URL:?}" "${GITHUB_REPOSITORY:?}" "${GITHUB_TOKEN:?}"
  host="${GITHUB_SERVER_URL#*://}"
  PAGES_REMOTE="${GITHUB_SERVER_URL%%://*}://x-access-token:${GITHUB_TOKEN}@${host}/${GITHUB_REPOSITORY}.git"
fi

case "$mode" in
  site) src="$(cd "${2:?built site directory}" && pwd)" ;;
  preview)
    number="${2:?pull request number}"
    src="$(cd "${3:?built site directory}" && pwd)"
    ;;
  remove) number="${2:?pull request number}" ;;
  *)
    echo "unknown mode: $mode" >&2
    exit 2
    ;;
esac
if [ -n "${number:-}" ] && ! [[ "$number" =~ ^[0-9]+$ ]]; then
  echo "pull request number must be digits: $number" >&2
  exit 2
fi

work="${PAGES_CHECKOUT:-$(mktemp -d)}"
[ -n "${PAGES_CHECKOUT:-}" ] || trap 'rm -rf "$work"' EXIT

# Another job may push between our fetch and our push, so retry from a fresh checkout.
for attempt in 1 2 3 4 5; do
  rm -rf "$work"
  mkdir -p "$work"
  git -C "$work" init -q
  git -C "$work" remote add origin "$PAGES_REMOTE"
  # The branch is kept at a single commit: it holds megabytes of firmware that change
  # nightly, and nobody needs their history. So take the current files, then start a
  # fresh history and replace the branch, but only if nobody else changed it meanwhile.
  lease=""
  if git -C "$work" fetch -q --depth 1 origin "$branch" 2>/dev/null; then
    lease="$(git -C "$work" rev-parse FETCH_HEAD)"
    git -C "$work" checkout -q --detach FETCH_HEAD
  fi
  git -C "$work" checkout -q --orphan "$branch"

  case "$mode" in
    site)
      # Replace everything except the previews.
      find "$work" -mindepth 1 -maxdepth 1 ! -name .git ! -name pr-preview -exec rm -rf {} +
      cp -R "$src"/. "$work"/
      message="Publish site${GITHUB_SHA:+ from ${GITHUB_SHA:0:8}}"
      ;;
    preview)
      rm -rf "$work/pr-preview/pr-$number"
      mkdir -p "$work/pr-preview/pr-$number"
      cp -R "$src"/. "$work/pr-preview/pr-$number"/
      message="Publish preview of pull request $number${GITHUB_SHA:+ from ${GITHUB_SHA:0:8}}"
      ;;
    remove)
      rm -rf "$work/pr-preview/pr-$number"
      message="Remove preview of pull request $number"
      ;;
  esac
  touch "$work/.nojekyll"

  git -C "$work" add -A
  if [ -n "$lease" ] && git -C "$work" diff --cached --quiet "$lease"; then
    echo "Nothing to publish."
    exit 0
  fi
  git -C "$work" -c user.name="${PAGES_USER:-pages-bot}" -c user.email="${PAGES_EMAIL:-pages-bot@users.noreply.invalid}" \
    commit -q -m "$message"
  if git -C "$work" push -q --force-with-lease="$branch:$lease" origin "$branch"; then
    echo "Published to $branch: $message"
    exit 0
  fi
  echo "Push failed (attempt $attempt); retrying."
  sleep $((attempt * 3))
done
echo "Could not push to $branch." >&2
exit 1
