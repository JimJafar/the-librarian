---
description: Toggle in-conversation private mode (no server state, no hook)
---

Flip the in-conversation private-mode marker. **Pure in-context** — no MCP call, no server flag, no plugin hook. The contract:

- `[librarian:private=on]` — agent must NOT call `remember` until told otherwise. `/handoff` and `/learn` require explicit user confirmation. Recall is still allowed (D3).
- `[librarian:private=off]` — normal operation.
- **Default when no marker is present:** OFF.

## Behaviour

1. Scan the conversation for the most recent `[librarian:private=on|off]` marker.
2. Inject a system message announcing the inverse state. Include both the machine token and a human-readable instruction so the LLM can re-emit it on its own if context compaction drops it. Suggested wording:
   - **ON:** "Private mode is ON. `[librarian:private=on]` — do not call `remember` until explicitly toggled off. Recall is still allowed. `/handoff` and `/learn` require explicit user confirmation. Remain in this state until told otherwise."
   - **OFF:** "Private mode is OFF. `[librarian:private=off]` — normal operation resumed."
3. Confirm to the user with a one-liner: `Private mode → ON` or `Private mode → OFF`.

## Known limitation

If the harness compacts the conversation and drops the system marker, the agent defaults to OFF and resumes writing durable memory. If a harness exposes a "context restored after compaction" signal, re-scan and re-inject the marker if it was on. Operators who need hard guarantees should run with `--no-compact` or equivalent.
