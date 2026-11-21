#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Self-test of ci/publish-pages-branch.sh against a throwaway repository on disk.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/one" "$tmp/two"
echo one >"$tmp/one/index.html"
echo two >"$tmp/two/index.html"
echo extra >"$tmp/two/extra.txt"
git init -q --bare "$tmp/remote.git"
export PAGES_REMOTE="$tmp/remote.git"
# The caller's settings (a workflow may set these for the real publish) must not leak in.
export PAGES_BRANCH=gh-pages
unset PAGES_CHECKOUT
remote() { git --git-dir="$tmp/remote.git" "$@"; }
files() { remote ls-tree -r --name-only gh-pages | tr '\n' ' '; }
expect() { [ "$1" = "$2" ] || { echo "FAIL: expected '$2', got '$1'" >&2; exit 1; }; }

"$here/publish-pages-branch.sh" site "$tmp/one"
expect "$(files)" ".nojekyll index.html "

"$here/publish-pages-branch.sh" preview 12 "$tmp/two"
expect "$(files)" ".nojekyll index.html pr-preview/pr-12/extra.txt pr-preview/pr-12/index.html "

# Replacing the site keeps the preview and leaves a single commit.
"$here/publish-pages-branch.sh" site "$tmp/two"
expect "$(files)" ".nojekyll extra.txt index.html pr-preview/pr-12/extra.txt pr-preview/pr-12/index.html "
expect "$(remote show gh-pages:index.html)" "two"
expect "$(remote rev-list --count gh-pages)" "1"

"$here/publish-pages-branch.sh" remove 12
expect "$(files)" ".nojekyll extra.txt index.html "
# Removing it again changes nothing and still succeeds.
before="$(remote rev-parse gh-pages)"
"$here/publish-pages-branch.sh" remove 12
expect "$(remote rev-parse gh-pages)" "$before"

# A pull request number that is not a number is refused.
if "$here/publish-pages-branch.sh" preview '1;rm' "$tmp/two" 2>/dev/null; then
  echo "FAIL: accepted a bad pull request number" >&2
  exit 1
fi
echo "publish-pages-branch.sh: all checks passed"
