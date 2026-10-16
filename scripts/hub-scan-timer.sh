#!/usr/bin/env bash
# Daily Hub and employer-board scan. Does not evaluate or submit.
set -euo pipefail

export PATH="${HOME}/.local/bin:/usr/bin:/bin"
ROOT=/home/armando/career-ops
cd "$ROOT"
node scripts/ensure-hub-schedule.mjs
exec node web/scripts/scheduled-jobs-runner.mjs
