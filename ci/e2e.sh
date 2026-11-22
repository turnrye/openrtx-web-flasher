#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Runs the browser tests against the built site in dist/ (run ci/build.sh first).
# Chromium is downloaded on first use; --with-deps also installs its system libraries
# when the job runs as root, which is the case on hosted and container runners.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$(id -u)" = "0" ] || [ -n "${CI:-}" ]; then
  npx playwright install --with-deps chromium
else
  npx playwright install chromium
fi
npx playwright test "$@"
