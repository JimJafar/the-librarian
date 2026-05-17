# Claude Code healthcheck

End-to-end smoke test for the Claude Code ↔ Librarian session integration.

## Prereqs

- Claude Code is configured with the canonical Librarian HTTP MCP endpoint (see [`mcp.example.json`](./mcp.example.json)).
- `LIBRARIAN_AGENT_TOKEN` is set in the environment Claude Code launches into.
- `the-librarian` CLI is installed locally (needed for the CLI cross-check) and `jq` is on PATH (needed by `wrapper.sh`).

## Steps

1. **List the session tools.** In Claude Code, ask the agent:
   ```
   List the MCP tools you have access to.
   ```
   Expected: the agent reports `start_session`, `list_sessions`, `continue_session`, `checkpoint_session`, `pause_session`, `end_session`, `archive_session`, `restore_session`, `delete_session`, `search_sessions`, `get_session`, `list_session_events`, `record_session_event`, `attach_session`, `promote_session_fact` in the tool surface (alongside the memory tools).

2. **Start a session.**
   ```
   /lib:session start "Claude healthcheck"
   ```
   Expected: the agent replies with a `session_id` (prefix `ses_`), visibility `common`, and a one-paragraph baseline.

3. **Record a decision.** Have the agent make a decision and call `record_session_event` with `type: "decision"`. Verify from a terminal:
   ```
   the-librarian sessions events <session_id>
   ```
   Expected: both `started` and `decision` events appear.

4. **Checkpoint and inspect the session.**
   ```
   /lib:session checkpoint
   ```
   Then:
   ```
   the-librarian sessions show <session_id>
   ```
   Expected: `rolling_summary` is populated. `current_harness: claude-code`. `source_ref` starts with `claude:session:` (when `CLAUDE_SESSION_ID` is set) or `cwd:`.

5. **Test the wrapper.** From a terminal, run a no-op claude invocation through the wrapper:
   ```
   integrations/claude-code/wrapper.sh --project the-librarian --title "Wrapper test" -- echo "hello"
   ```
   Expected: stderr shows `Librarian session: ses_...`. After the command exits, the session is paused:
   ```
   the-librarian sessions show <wrapper_session_id>
   ```
   Expected: `status: paused`, `paused_at` is set.

6. **Cross-harness handover.** From a terminal:
   ```
   the-librarian sessions continue <session_id> --agent cli --target-harness cli --format markdown --no-attach
   ```
   Expected: a markdown handover that mentions the start summary, the decision you recorded, and the checkpoint.

7. **End and archive.**
   ```
   /lib:session end
   ```
   Then archive or delete as appropriate.

## Pass/fail

The integration passes if all seven steps work, the wrapper's pause-on-exit trap fires correctly, and no session content was auto-promoted to durable memory.

## Common failures

- **`jq: command not found`** in wrapper.sh → install jq, or replace the jq line in the wrapper with another JSON extractor.
- **`Unauthorized` from MCP** → `LIBRARIAN_AGENT_TOKEN` is missing or wrong in Claude Code's environment.
- **`source_ref` shows `cwd:` instead of `claude:session:`** → Claude Code didn't expose `CLAUDE_SESSION_ID` in this context. That's fine; the session still functions, it just can't round-trip via Claude's `--resume`.
