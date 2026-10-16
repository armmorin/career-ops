#!/usr/bin/env bash
# Daily LinkedIn inlet. Starts the loopback server when it is down, then
# searches each confirmed title. Does not evaluate or submit.
set -euo pipefail

# shellcheck source=timer-path.sh
. "$(dirname "$0")/timer-path.sh"
ROOT=/home/armando/career-ops
ENDPOINT=http://127.0.0.1:8089/mcp

probe() {
  curl -fsS --max-time 5 -o /dev/null -X POST "$ENDPOINT" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"career-ops-linkedin-timer","version":"1"}}}'
}

if ! probe; then
  mkdir -p "$ROOT/data"
  uvx mcp-server-linkedin@latest --transport streamable-http --host 127.0.0.1 --port 8089 --path /mcp \
    >>"$ROOT/data/linkedin-mcp.log" 2>&1 &
  ready=0
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if probe; then
      ready=1
      break
    fi
    sleep 1
  done
  if [ "$ready" -ne 1 ]; then
    echo "LinkedIn server did not answer on ${ENDPOINT}" >&2
    exit 1
  fi
fi

cd "$ROOT"
exec node linkedin-inlet.mjs --from-titles
