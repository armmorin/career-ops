#!/usr/bin/env bash
# On a scheduled day, at user-session start, run the three searches to completion.
# 2026-10-18 is a run day. A second start the same day does not repeat a finished run.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=timer-path.sh
. "$HERE/timer-path.sh"
# shellcheck source=every-other-day.sh
. "$HERE/every-other-day.sh"

if ! on_run_day; then
  echo "Not a scheduled search day."
  exit 0
fi

ROOT="$(cd "$HERE/.." && pwd)"
mkdir -p "$ROOT/data"
day=$(TZ=Europe/Copenhagen date +%Y-%m-%d)
stamp="$ROOT/data/scheduled-day.stamp"
if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$day" ]; then
  echo "Scheduled search already finished on ${day}."
  exit 0
fi

fail=0
"$HERE/job-agent-inlet-timer.sh" &
inlet_pid=$!
"$HERE/hub-scan-timer.sh" &
scan_pid=$!
"$HERE/linkedin-alert-mail-timer.sh" &
mail_pid=$!

wait "$inlet_pid" || fail=1
wait "$scan_pid" || fail=1
wait "$mail_pid" || fail=1

if [ "$fail" -ne 0 ]; then
  echo "Scheduled search did not finish on ${day}." >&2
  exit 1
fi
printf '%s\n' "$day" >"$stamp"
echo "Scheduled search finished on ${day}."
