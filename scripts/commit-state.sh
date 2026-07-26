#!/usr/bin/env bash
# Commit state back to the repo. Safe to run concurrently with other workflows:
# each writes a disjoint set of files, so resetting onto the remote tip can
# never drop another job's work.
set -euo pipefail

BRANCH="${1:-main}"
MESSAGE="${2:-chore(state): update scraped state}"

git config user.name "deal-hunter-bot"
git config user.email "actions@users.noreply.github.com"

if git diff --quiet -- state/; then
  echo "no state changes"
  exit 0
fi

for attempt in 1 2 3; do
  git add state/
  git commit -q -m "$MESSAGE" || true

  # Shallow clones cannot rebase, so re-point at the remote tip and re-apply.
  git fetch --depth=1 origin "$BRANCH"
  git reset --soft FETCH_HEAD
  git add state/
  git commit -q -m "$MESSAGE" || { echo "nothing to commit"; exit 0; }

  if git push origin "HEAD:$BRANCH"; then
    echo "state pushed on attempt $attempt"
    exit 0
  fi
  echo "push rejected, retrying ($attempt/3)"
  sleep $((attempt * 5))
done

echo "failed to push state after 3 attempts" >&2
exit 1
