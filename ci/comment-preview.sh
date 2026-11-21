#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Posts (or updates) one comment on a pull request with the address of its preview.
# GitHub and Forgejo share this part of their API, and both runners set GITHUB_API_URL,
# GITHUB_REPOSITORY and GITHUB_TOKEN, so the same script serves both.
#
#   ci/comment-preview.sh <pull request number> <preview URL>
set -euo pipefail

number="${1:?pull request number}"
url="${2:?preview URL}"
: "${GITHUB_API_URL:?}" "${GITHUB_REPOSITORY:?}" "${GITHUB_TOKEN:?}"

marker='<!-- openrtx-web-flasher-preview -->'
body="$marker
Preview of this pull request: $url

Add \`?sim=1\` to try the whole flow against simulated radios: ${url}?sim=1

<sub>Built from ${GITHUB_SHA:-this branch}. Updated on every push; removed when the pull request closes.</sub>"

api="$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/issues"
auth=(-H "Authorization: token $GITHUB_TOKEN" -H "Content-Type: application/json")
payload="$(node -e 'process.stdout.write(JSON.stringify({ body: process.argv[1] }))' "$body")"

existing="$(curl -fsS "${auth[@]}" "$api/$number/comments?per_page=100" |
  node -e '
    let text = "";
    process.stdin.on("data", (d) => (text += d)).on("end", () => {
      const mine = JSON.parse(text).find((c) => c.body && c.body.includes(process.argv[1]));
      process.stdout.write(mine ? String(mine.id) : "");
    });' "$marker")"

if [ -n "$existing" ]; then
  curl -fsS -X PATCH "${auth[@]}" -d "$payload" "$api/comments/$existing" >/dev/null
  echo "Updated the preview comment."
else
  curl -fsS -X POST "${auth[@]}" -d "$payload" "$api/$number/comments" >/dev/null
  echo "Posted the preview comment."
fi
