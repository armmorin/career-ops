#!/usr/bin/env bash
# Daily Hub and employer-board scan. Does not evaluate or submit.
set -euo pipefail

# shellcheck source=timer-path.sh
. "$(dirname "$0")/timer-path.sh"
ROOT=/home/armando/career-ops
cd "$ROOT"
node scripts/ensure-hub-schedule.mjs
exec node web/scripts/scheduled-jobs-runner.mjs
