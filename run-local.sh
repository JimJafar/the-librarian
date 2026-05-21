#!/usr/bin/env bash
# Boot The Librarian's two services for local dev.
#
# The README has the same recipe inline, but each command there is a
# blocking foreground process — running them sequentially in a script
# never starts the dashboard. This wrapper runs install + seed once,
# then starts mcp-server and the dashboard in parallel and tears both
# down cleanly on Ctrl-C.

set -euo pipefail

cd "$(dirname "$0")"

# Idempotent setup. Re-running the script is cheap.
pnpm install
pnpm run seed

# Start both services in the background, capture their PIDs, and make
# sure Ctrl-C (or any script exit) kills the whole tree rather than
# leaving the mcp-server orphaned on port 3838.
pnpm run serve &
SERVE_PID=$!
pnpm --filter @librarian/dashboard dev &
DASH_PID=$!

cleanup() {
  echo
  echo "[run-local] stopping mcp-server ($SERVE_PID) + dashboard ($DASH_PID)…"
  kill "$SERVE_PID" "$DASH_PID" 2>/dev/null || true
  wait "$SERVE_PID" 2>/dev/null || true
  wait "$DASH_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo
echo "[run-local] mcp-server: http://127.0.0.1:3838  (pid $SERVE_PID)"
echo "[run-local] dashboard:  http://127.0.0.1:3000  (pid $DASH_PID)"
echo "[run-local] Ctrl-C to stop both."

# Block on whichever exits first; the trap then tears the other down.
wait -n "$SERVE_PID" "$DASH_PID"
