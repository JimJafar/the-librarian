#!/usr/bin/env bash
# integrations/codex/wrapper.sh
#
# Brackets a `codex` invocation with The Librarian session lifecycle:
#   - starts a session before codex launches
#   - exposes LIBRARIAN_SESSION_ID to the child process
#   - pauses the session on exit (process exit rarely matches a coherent stopping point)
#
# Usage:
#   wrapper.sh [--project KEY] [--agent ID] [--title TITLE] -- codex [args...]
#
# Dependencies: bash, the-librarian CLI on PATH, jq.

set -euo pipefail

LIBRARIAN_BIN="${LIBRARIAN_BIN:-the-librarian}"
AGENT="${LIBRARIAN_AGENT:-codex}"
PROJECT="${LIBRARIAN_PROJECT:-}"
TITLE=""
HARNESS="codex"
CWD="$(pwd)"

# Source ref: prefer a Codex run id when available, fall back to cwd.
if [[ -n "${CODEX_RUN_ID:-}" ]]; then
  SOURCE_REF="codex:run:${CODEX_RUN_ID}:cwd:${CWD}"
else
  SOURCE_REF="cwd:${CWD}"
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --agent)   AGENT="$2"; shift 2 ;;
    --title)   TITLE="$2"; shift 2 ;;
    --source-ref) SOURCE_REF="$2"; shift 2 ;;
    --)        shift; break ;;
    *)         break ;;
  esac
done

START_ARGS=(sessions start --agent "$AGENT" --harness "$HARNESS" --cwd "$CWD" --source-ref "$SOURCE_REF" --json)
if [[ -n "$TITLE" ]];   then START_ARGS+=(--title "$TITLE"); fi
if [[ -n "$PROJECT" ]]; then START_ARGS+=(--project "$PROJECT"); fi

START_RESPONSE="$("$LIBRARIAN_BIN" "${START_ARGS[@]}")"
LIBRARIAN_SESSION_ID="$(printf '%s' "$START_RESPONSE" | jq -r '.session.id')"

if [[ -z "$LIBRARIAN_SESSION_ID" || "$LIBRARIAN_SESSION_ID" == "null" ]]; then
  echo "wrapper.sh: failed to parse session id from start response" >&2
  echo "$START_RESPONSE" >&2
  exit 1
fi

export LIBRARIAN_SESSION_ID
echo "Librarian session: $LIBRARIAN_SESSION_ID" >&2

pause_on_exit() {
  local exit_code=$?
  "$LIBRARIAN_BIN" sessions pause "$LIBRARIAN_SESSION_ID" \
    --agent "$AGENT" \
    --summary "Process exited (status $exit_code)" >/dev/null 2>&1 || true
  exit "$exit_code"
}
trap pause_on_exit EXIT INT TERM

if [[ $# -gt 0 ]]; then
  "$@"
else
  codex
fi
