#!/usr/bin/env bash
# Hub and employer-board scan. Runs every other day from 2026-10-18.
# Does not evaluate or submit.
set -euo pipefail

# shellcheck source=timer-path.sh
. "$(dirname "$0")/timer-path.sh"
# shellcheck source=every-other-day.sh
. "$(dirname "$0")/every-other-day.sh"
if ! on_run_day; then
  echo "Skipping the Hub scan. The scanners run every other day from 2026-10-18."
  exit 0
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
node scripts/ensure-hub-schedule.mjs
exec node web/scripts/scheduled-jobs-runner.mjs
