---
description: Pick up a handoff from another agent / harness
---

Claim a handoff stored via `/handoff` and continue the work. Atomic — the row is yours once claimed; no one else can pick it up.

## List

Call `list_handoffs` with the caller's `project_key` and `cwd`. If empty, broaden by dropping filters in this order: drop `harness`, then `cwd`, then `project_key`. Stop at the first non-empty result. If still empty after dropping everything, tell the user "no handoffs available for this context."

## Present

For each candidate, render `title`, `created_in_harness`, `created_at` (age computed locally — "X minutes ago"), and `tags`. Number them and ask the user to pick one (or "none").

## Claim

On selection, call `claim_handoff` with:

- `handoff_id`
- `claiming_agent_id` — the current agent id
- `claiming_harness` — the harness you are running in (e.g. `"claude-code"`, `"opencode"`)
- `claiming_source_ref` — a stable reference to where the work resumes: the harness conversation/run id if one is available, else `cwd:<absolute path>`
- `claiming_cwd` — current working directory

On success: inject the returned `document_md` into the conversation (the user sees it once, the model now knows the full story). Echo a one-line confirmation: `claimed hdo_xyz, picking up from agent-a (claude-code, 4 minutes ago)`.

On `error: "already_claimed"`: tell the user who claimed it and when, and offer to re-list.

On `error: "not_found"`: tell the user the row is gone (purged or never stored) and offer to re-list.
