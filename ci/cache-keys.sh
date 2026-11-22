#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Works out what the CI caches depend on and hands it to the workflow as step outputs.
# Run it after the cache of pinned downloads has been restored.
#
#   emsdk        the pinned Emscripten commit: the key of the toolchain cache
#   needs_emsdk  "true" when cskburn has to be compiled in this run, so the 1.8 GB
#                toolchain is only restored (or downloaded) when it will be used
#   week         the ISO week: the firmware cache is saved afresh once a week
set -euo pipefail
cd "$(dirname "$0")/.."
{
  echo "emsdk=$(node -p "require('./vendor.json').emsdk.commit")"
  echo "needs_emsdk=$(node scripts/vendor.mjs --needs-emsdk)"
  echo "week=$(date -u +%G-%V)"
} | tee -a "${GITHUB_OUTPUT:-/dev/null}"
