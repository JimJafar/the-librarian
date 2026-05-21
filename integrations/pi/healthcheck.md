# Pi healthcheck

End-to-end smoke test for the Pi ↔ Librarian session integration. This is intentionally low-dependency given the open question about Pi's runtime interface — adapt the steps below once the interface is finalised.

## Prereqs

- The Pi device can reach `the-librarian` CLI (either bundled locally, or via SSH to a host that has it).
- `LIBRARIAN_AGENT_TOKEN` is set in the environment from which the wrapper runs, if you're using HTTP MCP transport.
- `jq` is on PATH (needed by `wrapper.sh`).

## Steps

1. **Start a Pi session via the wrapper.**
   ```sh
   integrations/pi/wrapper.sh --project the-librarian --device test-device-01 --title "Pi healthcheck" -- echo "ok"
   ```
   Expected: stderr shows `Librarian session: ses_...`. The command exits cleanly. The session is paused on exit.

2. **Inspect the new session.**
   ```sh
   the-librarian sessions show <session_id>
   ```
   Expected: `current_harness: pi`, `source_ref: pi:device:test-device-01` (or `cwd:` if no device id was supplied), `capture_mode: summary`, `status: paused`.

3. **Resume from another harness.**
   ```sh
   the-librarian sessions continue <session_id> --agent cli --target-harness cli --target-cwd "$PWD"
   ```
   Expected: handover text references the wrapper's start summary. `current_harness` flips to `cli`.

4. **List Pi sessions for the device.**
   ```sh
   the-librarian sessions list --harness pi
   ```
   Expected: the session you created appears in the list.

5. **End the session.**
   ```sh
   the-librarian sessions end <session_id> --summary "Healthcheck complete."
   ```
   Expected: the session moves to `ended`. The bare-call (no `--summary`) abandonment path is supported too. The session can later be brought back via `the-librarian sessions continue <session_id>`.

## Pass/fail

The integration passes if the wrapper boots a session cleanly, exits with `paused` status, and the session is reachable from other harnesses via standard `continue` / `list` calls.

## Common failures

- **`jq: command not found`** → install jq, or rewrite the wrapper's parse step. `jq` is the only external dep besides `the-librarian`.
- **`Unauthorized`** when transport is `http_mcp` → `LIBRARIAN_AGENT_TOKEN` is missing or wrong.
- **`source_ref` is `cwd:`** instead of `pi:device:...` → pass `--device <id>` to the wrapper (or set `PI_DEVICE_ID`).
- **The wrapper exits but the session is still `active`** → the trap didn't fire. Confirm the wrapper exits via `EXIT` (or `SIGINT`/`SIGTERM`) and that `the-librarian` is on PATH when the trap runs.
