#!/usr/bin/env bash
# integrations/claude-code/wrapper.sh
#
# Brackets a `claude` invocation with The Librarian session lifecycle:
#   - starts a session before claude launches
#   - exposes LIBRARIAN_SESSION_ID to the child process
#   - pauses the session on exit (not ends — process exit is rarely a coherent stopping point)
#
# Usage:
#   wrapper.sh [--project KEY] [--agent ID] [--title TITLE] -- claude [args...]
#
# Dependencies: bash, the-librarian CLI on PATH, jq.

set -euo pipefail

LIBRARIAN_BIN="${LIBRARIAN_BIN:-the-librarian}"
AGENT="${LIBRARIAN_AGENT:-claude}"
PROJECT="${LIBRARIAN_PROJECT:-}"
TITLE=""
HARNESS="claude-code"
CWD="$(pwd)"

# Source ref: prefer Claude's native session id when available, fall back to cwd.
if [[ -n "${CLAUDE_SESSION_ID:-}" ]]; then
  SOURCE_REF="claude:session:${CLAUDE_SESSION_ID}"
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

# Run the actual harness with whatever arguments remain.
if [[ $# -gt 0 ]]; then
  "$@"
else
  claude
fi
