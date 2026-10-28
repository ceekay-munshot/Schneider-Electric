#!/usr/bin/env bash
# Record a capture attempt's health, publish its data (publish-dashboard-data.js
# refuses anything that isn't a real, priced capture) and push both to main.
#
# Each attempt starts from a fresh origin/main and re-applies the update, so a
# concurrent push (another category, a merged PR) can never cause a rebase
# conflict or a lost week of data. Retries with backoff.
#
# Usage: scripts/commit-capture.sh <slug>
# Env:   CAPTURE_OUTCOME (step outcome: success|failure|cancelled), RUN_URL
set -uo pipefail

slug="${1:?usage: commit-capture.sh <slug>}"
src="output/graybar-${slug}-latest.json"
data="public/data/${slug}.json"
health="public/data/${slug}-health.json"
outcome="${CAPTURE_OUTCOME:-unknown}"

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

for attempt in 1 2 3 4 5; do
  if ! git fetch --quiet origin main || ! git reset --quiet --hard origin/main; then
    echo "[commit] attempt ${attempt}: could not sync with origin/main"
    sleep $((attempt * 20))
    continue
  fi
  node scripts/record-health.js "$health" "$src"
  node scripts/publish-dashboard-data.js "$src" "$data"
  git add "$data" "$health"
  if git diff --cached --quiet; then
    echo "[commit] no dashboard data change for ${slug}; nothing to commit."
    exit 0
  fi
  # No [skip ci] here: Cloudflare Pages treats it as a build-skip directive,
  # which is exactly the build that publishes this data. GitHub Actions can't
  # loop on this push anyway (GITHUB_TOKEN pushes never trigger workflows).
  git commit --quiet -m "data: weekly ${slug} capture refresh (${outcome})"
  if git push --quiet origin HEAD:main; then
    echo "[commit] pushed ${slug} (${outcome}) on attempt ${attempt}"
    exit 0
  fi
  echo "[commit] attempt ${attempt}: push rejected; re-syncing and retrying"
  sleep $((attempt * 20))
done
echo "[commit] giving up after 5 attempts"
exit 1
