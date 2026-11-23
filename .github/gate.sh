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

# GitHub's own API fails now and then (a 502 was seen): the question which jobs ran is asked again
# before the gate fails for it. A gate that failed this way says so, and blames no job.
jobs=
for try in 1 2 3 4 5; do
  if jobs=$(gh api --paginate --slurp \
    "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/jobs?filter=all&per_page=100"); then
    break
  fi
  jobs=
  if [ "$try" -lt 5 ]; then sleep $((try * 10)); fi
done
if [ -z "$jobs" ]; then
  echo "GitHub did not say which jobs of this run ran, asked five times. Re-run this job."
  exit 1
fi

legs=$(
  jq -r --arg gate "$gate" --argjson attempt "$GITHUB_RUN_ATTEMPT" '
    [.[].jobs[] | select(.name != $gate and .run_attempt <= $attempt)]
    | group_by(.name)[] | max_by([.run_attempt, .id])
    | "\(.conclusion // .status)\t\(.name)"' <<<"$jobs"
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
