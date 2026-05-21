# Codex healthcheck

End-to-end smoke test for the Codex ↔ Librarian session integration.

## Prereqs

- Codex is configured with the canonical Librarian HTTP MCP endpoint (see [`mcp.example.json`](./mcp.example.json)).
- `LIBRARIAN_AGENT_TOKEN` is set in Codex's environment.
- `the-librarian` CLI is on PATH and `jq` is installed (needed by `wrapper.sh`).

## Steps

1. **Verify the session tool surface.** In Codex, ask:
   ```
   What MCP tools do you have available?
   ```
   Expected: the agent lists `start_session`, `list_sessions`, `continue_session`, `checkpoint_session`, `pause_session`, `end_session`, `search_sessions`, `get_session`, `list_session_events`, `record_session_event`, `attach_session`, `promote_session_fact` alongside the memory tools. The retired tools `archive_session`, `restore_session`, `delete_session` should NOT be in the list.

2. **Start a session.**
   ```
   /lib:session start "Codex healthcheck"
   ```
   Expected: agent replies with a `session_id` (prefix `ses_`), visibility `common`, baseline summary.

3. **Record evidence.** Have the agent make a decision and call `record_session_event`. Verify:
   ```
   the-librarian sessions events <session_id>
   ```
   Expected: `started` and `decision` events present.

4. **Test the wrapper.** From a terminal at a project root:
   ```
   integrations/codex/wrapper.sh --project the-librarian --title "Wrapper test" -- echo "hello"
   ```
   Expected: stderr shows `Librarian session: ses_...`. After exit, the wrapper-created session is paused:
   ```
   the-librarian sessions show <wrapper_session_id>
   ```
   Expected: `status: paused`, `source_ref` starts with `cwd:` (or `codex:run:...` if a run id was available).

5. **Cross-harness handover.** From a terminal:
   ```
   the-librarian sessions continue <session_id> --agent cli --target-harness cli --format codex --no-attach
   ```
   Expected: a concise AGENTS-style handover that mentions the start summary, the decision, and any checkpoints.

6. **End the session.**
   ```
   /lib:session end
   ```
   Expected: the session is moved to `ended` status. The bare-call (no summary) abandonment path is supported. The session can later be brought back via `/lib:session resume <id>`.

## Pass/fail

The integration passes if all six steps work, the wrapper exits cleanly with a paused session, and no session content was auto-promoted to durable memory.

## Common failures

- **`jq: command not found`** in wrapper.sh → install jq, or replace the jq line in the wrapper with another JSON extractor.
- **`Unauthorized` from MCP** → `LIBRARIAN_AGENT_TOKEN` is missing in Codex's environment.
- **`source_ref` shows `cwd:` instead of `codex:run:...`** → Codex didn't expose `CODEX_RUN_ID` in this context; the session still functions.
