#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Checks and builds the site into dist/. The same script runs on GitHub Actions, on
# Forgejo Actions and on a laptop; any failing check stops the build.
#
#   ci/build.sh                 vendor, check, mirror firmware, test, build
#   MIRROR=skip ci/build.sh     the same without contacting GitHub for firmware
#
# GITHUB_TOKEN, when set, is only used to raise GitHub's API rate limit for the mirror.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n== %s\n' "$1"; }

step "Install packages (versions pinned by package-lock.json)"
npm ci

step "Fetch and build pinned third-party parts (vendor.json)"
node scripts/vendor.mjs

step "Format, lint and types"
npm run format:check
npm run lint
npm run lint:css
npm run lint:sh
npm run typecheck

if [ "${MIRROR:-strict}" = "skip" ]; then
  step "Firmware mirror skipped"
else
  step "Mirror firmware"
  node scripts/mirror-firmware.mjs --out public --strict
fi

step "Unit tests"
# With firmware mirrored, the flasher tests also parse and flash real release files.
releases="public/firmware/v0.4.5"
if [ -d "$releases" ]; then
  ORTX_RELEASE_DIR="$PWD/$releases" npm test
else
  npm test
fi
bash ci/test-publish.sh

step "Build"
npx vite build
# GitHub Pages must not run the files through Jekyll.
touch dist/.nojekyll
echo "Built dist/: $(find dist -type f | wc -l | tr -d ' ') files, $(du -sh dist | cut -f1)"
