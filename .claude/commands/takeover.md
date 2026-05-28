---
description: Pick up a handoff from another agent / harness
---

Claim a handoff stored via `/handoff` and continue the work. Atomic — the row is yours once claimed; no one else can pick it up.

## List

Call `list_handoffs` with the caller's `project_key`, `cwd`, and `conv_id`. If empty, broaden by dropping filters in this order: drop `harness`, then `cwd`, then `project_key`. Stop at the first non-empty result. If still empty after dropping everything, tell the user "no handoffs available for this context."

## Present

For each candidate, render `title`, `created_in_harness`, `created_at` (age computed locally — "X minutes ago"), and `tags`. Number them and ask the user to pick one (or "none").

## Claim

On selection, call `claim_handoff` with:

- `handoff_id`
- `claiming_agent_id` — the current agent id
- `claiming_harness` — `"claude-code"`
- `claiming_source_ref` — `claude:session:${CLAUDE_SESSION_ID}` if available, else `cwd:<path>`
- `claiming_cwd` — current working directory
- `conv_id` — the harness conversation id

On 200: inject the returned `document_md` into the conversation as system context (the user sees it once, the model now knows the full story). Echo a one-line confirmation: `claimed hdo_xyz, picking up from agent-a (claude-code, 4 minutes ago)`.

On `error: "already_claimed"`: tell the user who claimed it and when, and offer to re-list.

On `error: "not_found"`: tell the user the row is gone (purged or in another domain) and offer to re-list.
