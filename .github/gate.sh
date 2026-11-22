#!/usr/bin/env bash
# A workflow's gate: passes only when every leg of the run's matrix ran and passed.
# needs.<job>.result is not enough: GitHub has reported success for a matrix one of whose legs was
# cancelled before it started. After "Re-run failed jobs" a leg counts with its newest result up to
# this attempt. A leg that skipped, was cancelled, timed out or failed, or is missing, fails it.
#
# Usage: gate.sh <name of the gate job> <number of legs>
set -euo pipefail
gate=$1
expected=$2

legs=$(
  gh api --paginate --slurp \
    "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/jobs?filter=all&per_page=100" |
    jq -r --arg gate "$gate" --argjson attempt "$GITHUB_RUN_ATTEMPT" '
      [.[].jobs[] | select(.name != $gate and .run_attempt <= $attempt)]
      | group_by(.name)[] | max_by([.run_attempt, .id])
      | "\(.conclusion // .status)\t\(.name)"'
)
printf '%s\n' "$legs"

found=$(grep -c . <<<"$legs" || true)
passed=$(grep -c $'^success\t' <<<"$legs" || true)
if [ "$found" -ne "$expected" ]; then
  echo "Expected $expected jobs and found $found: a job of this run is missing."
  exit 1
fi
if [ "$passed" -ne "$expected" ]; then
  echo "$((expected - passed)) of $expected jobs did not pass."
  exit 1
fi
echo "All $expected jobs passed."
