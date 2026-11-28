#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Prints the path this run's build of the site will be served under, with a slash at
# both ends. Astro writes absolute links, so the build has to know (SITE_BASE,
# astro.config.ts); the browser tests then serve dist/ under the same path.
#
#   the main site        <root>                 e.g. /openrtx-web-flasher/
#   a pull request       <root>pr-preview/pr-N/
#
# <root> is, in this order:
#   SITE_ROOT   set it when the site has its own domain: /
#   PAGES_URL   the address a Pages host serves the repository at (Forgejo): its path
#   otherwise   /<repository name>/, where GitHub Pages serves a project site
#
# Environment: GITHUB_REPOSITORY (owner/name), PR_NUMBER (empty unless a pull request).
set -euo pipefail

if [ -n "${SITE_ROOT:-}" ]; then
  root="$SITE_ROOT"
elif [ -n "${PAGES_URL:-}" ]; then
  # Everything after the host name.
  rest="${PAGES_URL#*://}"
  case "$rest" in
    */*) root="/${rest#*/}" ;;
    *) root="/" ;;
  esac
else
  : "${GITHUB_REPOSITORY:?}"
  root="/${GITHUB_REPOSITORY##*/}/"
fi

# One slash at each end, whatever was given.
root="/${root#/}"
root="${root%/}/"

if [ -n "${PR_NUMBER:-}" ]; then
  echo "${root}pr-preview/pr-${PR_NUMBER}/"
else
  echo "$root"
fi
