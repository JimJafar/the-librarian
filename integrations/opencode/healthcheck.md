# OpenCode healthcheck

End-to-end smoke test for the OpenCode ↔ Librarian session integration.

## Prereqs

- OpenCode is configured with the canonical Librarian HTTP MCP endpoint (see [`opencode.example.json`](./opencode.example.json)).
- `/lib:session` is registered as a command (see [`commands.example.json`](./commands.example.json)).
- `LIBRARIAN_AGENT_TOKEN` is set in OpenCode's environment.
- `the-librarian` CLI is on PATH and `jq` is installed (needed by `wrapper.sh`).

## Steps

1. **Verify the command registration.** In OpenCode, type `/lib:session` and observe autocompletion. Expected: the command appears with the subcommand-as-free-text hint.

2. **Verify the session tool surface.** Ask the agent:
   ```
   List the MCP tools you have available.
   ```
   Expected: agent reports `start_session`, `list_sessions`, `continue_session`, `checkpoint_session`, `pause_session`, `end_session`, `search_sessions`, `get_session`, `list_session_events`, `record_session_event`, `attach_session`, `promote_session_fact`. The retired tools `archive_session`, `restore_session`, `delete_session` should NOT be in the list.

3. **Start a session.**
   ```
   /lib:session start "OpenCode healthcheck"
   ```
   Expected: `session_id` (prefix `ses_`), visibility `common`, baseline summary.

4. **Record evidence and checkpoint.** Have the agent record a decision and call `/lib:session checkpoint`. Verify:
   ```
   the-librarian sessions show <session_id>
   ```
   Expected: `current_harness: opencode`, `source_ref` starts with `opencode:project:`, `rolling_summary` populated.

5. **Test the wrapper.** From a terminal at a project root:
   ```sh
   integrations/opencode/wrapper.sh --project the-librarian --title "Wrapper test" -- echo "ok"
   ```
   Expected: stderr shows `Librarian session: ses_...`. After exit, the wrapper-created session is paused, and its attach event reflects opencode-as-current.

6. **Cross-harness handover.** From a terminal:
   ```
   the-librarian sessions continue <session_id> --agent cli --target-harness cli --format opencode --no-attach
   ```
   Expected: an OpenCode-friendly handover that mentions the start summary, the checkpoint, and the decision.

7. **End the session.**
   ```
   /lib:session end
   ```
   Expected: the session moves to `ended` status. The bare-call (no summary) abandonment path is supported. The session can later be brought back via `/lib:session resume <id>`.

## Pass/fail

The integration passes if all seven steps work, the wrapper exits with a paused session, and no session content was auto-promoted to durable memory.

## Common failures

- **`/lib:session` not autocompleting** → the command registration in `commands.example.json` wasn't merged in, or OpenCode wasn't restarted after the merge.
- **`jq: command not found`** → install jq, or rewrite the wrapper's parse step.
- **`Unauthorized`** → `LIBRARIAN_AGENT_TOKEN` is missing or wrong in OpenCode's environment.
