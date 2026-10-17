#!/usr/bin/env bash
# LinkedIn alert mail. Appends Pending rows. Runs every other day from
# 2026-10-18, with the Danish inlet and the Hub scan. Does not evaluate or submit.
set -euo pipefail

# shellcheck source=timer-path.sh
. "$(dirname "$0")/timer-path.sh"
# shellcheck source=every-other-day.sh
. "$(dirname "$0")/every-other-day.sh"
if ! on_run_day; then
  echo "Skipping LinkedIn alert mail. The scanners run every other day from 2026-10-18."
  exit 0
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec node linkedin-alert-mail.mjs --gmail --write
