#!/usr/bin/env bash
# integrations/codex/hooks/librarian/dispatch.sh
#
# Single Codex hook entrypoint for The Librarian lifecycle. Every hook event
# (UserPromptSubmit, PostCompact, SessionStart, …) routes here — the
# `librarian-codex-hook` bin reads the hook_event_name from the JSON on stdin
# and dispatches (see integrations/shared/librarian-lifecycle/src/harness/codex.ts).
#
# This is the privacy gate. Codex CAN block a prompt (exit 2 / {"decision":"block"}),
# but this hook deliberately does NOT: the privacy guarantee is "no Librarian
# call", not "stop the model". It always exits 0 and never blocks the prompt.
#
# Requires `the-librarian` and `librarian-codex-hook` (from @librarian/lifecycle)
# on PATH. Set LIBRARIAN_AGENT_ID (default codex) and optionally
# LIBRARIAN_PROJECT_KEY. Pause-on-exit is handled by wrapper.sh, not a hook
# (Codex has no SessionEnd event).

set -uo pipefail

BIN="${LIBRARIAN_CODEX_HOOK_BIN:-librarian-codex-hook}"

if ! command -v "$BIN" >/dev/null 2>&1; then
  exit 0 # lifecycle helper not installed: do nothing, never block the prompt
fi

"$BIN" || true
exit 0
