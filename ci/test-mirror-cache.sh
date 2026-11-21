#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Checks that the firmware mirror survives GitHub being unreachable: after one good
# mirror, a second one with the API address pointed nowhere must still produce the same
# builds, from the cache. Needs network for the first half.
#
#   ci/test-mirror-cache.sh
set -euo pipefail
cd "$(dirname "$0")/.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export ORTX_CACHE="$tmp/cache"
# Two releases are enough to show the point.
export ORTX_RELEASES=2

# Prints "build/file checksum" for every file in a manifest. The quoted text is JavaScript.
# shellcheck disable=SC2016
names() { node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log(m.builds.flatMap((b) => b.files.map((f) => `${b.id}/${f.name} ${f.sha256}`)).sort().join("\n"));
' "$1"; }

echo "== First mirror, from GitHub"
node scripts/mirror-firmware.mjs --out "$tmp/one" --strict
names "$tmp/one/firmware/manifest.json" >"$tmp/one.txt"

echo "== Second mirror, with GitHub unreachable"
ORTX_GITHUB_API="http://127.0.0.1:9" node scripts/mirror-firmware.mjs --out "$tmp/two" --strict 2>&1 | tee "$tmp/two.log"
names "$tmp/two/firmware/manifest.json" >"$tmp/two.txt"

grep -q "WARNING: using the copy mirrored on" "$tmp/two.log" || { echo "FAIL: no fall-back warning" >&2; exit 1; }
diff "$tmp/one.txt" "$tmp/two.txt" || { echo "FAIL: the fall-back mirror differs" >&2; exit 1; }
[ -s "$tmp/one.txt" ] || { echo "FAIL: nothing was mirrored" >&2; exit 1; }
echo "mirror fall-back: $(wc -l <"$tmp/one.txt" | tr -d ' ') files identical with GitHub unreachable"
