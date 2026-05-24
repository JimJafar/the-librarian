#!/usr/bin/env bash
# integrations/claude-code/hooks/librarian/dispatch.sh
#
# Single Claude Code hook entrypoint for The Librarian lifecycle. Every hook
# event (UserPromptSubmit, PostCompact, TaskCompleted, SessionEnd, SessionStart,
# Stop) routes here — the `librarian-claude-hook` bin reads the hook_event_name
# from the JSON on stdin and dispatches (see
# integrations/shared/librarian-lifecycle/src/harness/claude-code.ts).
#
# This is the privacy gate: it MUST run before the prompt reaches the model and
# before any other Librarian hook. It NEVER blocks the prompt — the privacy
# guarantee is "no Librarian call", not "stop the model" — so it always exits 0.
#
# Environment (set by the wrapper / your shell):
#   LIBRARIAN_AGENT_ID     canonical agent id for attribution (default claude-code)
#   LIBRARIAN_PROJECT_KEY  optional project key for session matching
#   LIBRARIAN_SECRET_KEY   forwarded to the CLI if your store needs it
# Requires `the-librarian` and `librarian-claude-hook` on PATH.

set -uo pipefail

BIN="${LIBRARIAN_CLAUDE_HOOK_BIN:-librarian-claude-hook}"

if ! command -v "$BIN" >/dev/null 2>&1; then
  # Lifecycle helper not installed: do nothing, never block the prompt.
  exit 0
fi

# The bin reads the event JSON from this script's stdin and always exits 0.
# Guard anyway so a helper failure can never surface as a blocking hook error.
"$BIN" || true
exit 0
