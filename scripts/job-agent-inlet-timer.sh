#!/usr/bin/env bash
# Danish inlet. Starts the loopback job-agent when it is down, then searches
# each confirmed title. Runs every other day from 2026-10-18. Does not evaluate or submit.
set -euo pipefail

# shellcheck source=timer-path.sh
. "$(dirname "$0")/timer-path.sh"
# shellcheck source=every-other-day.sh
. "$(dirname "$0")/every-other-day.sh"
if ! on_run_day; then
  echo "Skipping the Danish inlet. The scanners run every other day from 2026-10-18."
  exit 0
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT="${JOB_AGENT_ROOT:-$ROOT/../job-agent}"
HEALTH=http://127.0.0.1:43104/health

if ! curl -fsS --max-time 2 "$HEALTH" >/dev/null; then
  mkdir -p "$ROOT/data"
  (
    cd "$AGENT"
    MCP_HOST=127.0.0.1 MCP_PORT=43104 bun run src/providers/danish/mcp-http.ts
  ) >>"$ROOT/data/job-agent-mcp.log" 2>&1 &
  ready=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS --max-time 2 "$HEALTH" >/dev/null; then
      ready=1
      break
    fi
    sleep 0.5
  done
  if [ "$ready" -ne 1 ]; then
    echo "job-agent did not answer on ${HEALTH}" >&2
    exit 1
  fi
fi

cd "$ROOT"
exec node job-agent-inlet.mjs --from-titles --limit 5
