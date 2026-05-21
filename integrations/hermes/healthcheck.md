# Hermes healthcheck

End-to-end smoke test for the Hermes ↔ Librarian session integration. Run after installing the package, before relying on it.

## Prereqs

- Hermes is configured with the canonical Librarian HTTP MCP endpoint and a working agent token.
- `the-librarian` CLI is installed locally (only needed for the cross-check in step 6).
- A test Discord thread you don't mind writing session events into.

## Steps

1. **Start a session from Hermes.** In the test thread, send:
   ```
   /lib:session start "Hermes healthcheck"
   ```
   Expected: the agent replies with a `session_id` (prefix `ses_`), the visibility (`common`), and a one-paragraph baseline. The agent should NOT have prompted for sensitivity confirmation (the title is benign).

2. **Record an evidence event.** Have the agent make a decision and call `record_session_event`. From outside Hermes, verify via the dashboard or CLI:
   ```
   the-librarian sessions events <session_id>
   ```
   Expected: the event stream includes both `started` and the `decision` (or whatever payload type the agent used).

3. **Checkpoint.** Send:
   ```
   /lib:session checkpoint
   ```
   Expected: the agent summarises work since start and the session's `rolling_summary` updates. Session stays `active`.

4. **Confirm the source_ref.**
   ```
   the-librarian sessions show <session_id>
   ```
   Expected: `Source: discord:channel:<channel_id>:thread:<thread_id>` is populated. `created_in_harness: hermes`. `current_harness: hermes`.

5. **Pause from Hermes, resume from CLI.**
   ```
   /lib:session pause
   ```
   Then from a terminal:
   ```
   the-librarian sessions continue <session_id> --agent cli --target-harness cli --target-cwd "$PWD"
   ```
   Expected: the handover text references the start summary, the checkpoint summary, and the decisions you recorded. `current_harness` is now `cli`. The session implicitly resumed because attach was recorded.

6. **Search.** From a terminal:
   ```
   the-librarian sessions search "Hermes healthcheck"
   ```
   Expected: the session you just exercised appears in the matches.

7. **End and clean up.** From Hermes:
   ```
   /lib:session end
   ```
   Expected: the session moves to `ended` and disappears from default `list_sessions` results. The bare-call (no summary) abandonment path is supported. The session can later be brought back via `/lib:session resume <session_id>` (which flips it back to `paused`).

## Pass/fail

The integration passes if all seven steps work without an "Unauthorized" error from MCP, without an "Unknown tool" error from the dispatcher, and without surprise auto-promotion of session content into durable memory.

## Common failures

- **401 Unauthorized** on MCP calls → the agent token isn't configured. Re-check `LIBRARIAN_AGENT_TOKEN` (or per-agent `LIBRARIAN_AGENT_TOKENS` on the server side).
- **"No session found"** when resuming from CLI → the CLI `--agent` value is different from the agent that owns the session AND the session is `agent_private`. Either supply the owning agent's id or start the session with `--private` only when intended.
- **`source_ref` is empty** → Hermes wasn't given enough Discord metadata at session start. Pass `--source-ref discord:channel:.../thread:...` explicitly when starting from text fallback.
