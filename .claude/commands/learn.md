---
description: Extract durable lessons from this conversation into memory proposals
---

Find candidate lessons in the current conversation and feed the user-approved ones into `propose_memory` (the existing proposal flow handles protected categories the usual way).

## Privacy gate

Before doing anything else, scan the conversation for the most recent `[librarian:private=on|off]` marker. If it is `on`, ask the user to confirm explicitly that they want lessons from this conversation written to durable memory. Abort on "no".

## Read

Read the full transcript via the harness's native API; fall back to the in-context view if no transcript API is available.

## Extract

Look for things worth keeping across future conversations:

- **Durable facts** about the user, project, infra, or constraints ("user is X", "project uses Y", "we deploy on Z").
- **Validated patterns** the user explicitly confirmed worked ("we found Z works because…", "yes, keep doing that").
- **Explicit user corrections** ("no not that, do it this way") — quote enough surrounding context for the lesson to make sense out of session.

Reject:

- Ephemeral state (current task progress, transient debugging).
- Things already captured in code (file paths, function names that grep covers).
- Surface-level summaries that don't change future behaviour.

## Present

Render the candidate lessons as a numbered multi-select list. For each, show a one-line title and a 1–2 line body. Ask the user which to keep — they can pick any subset, including none.

## Save

For each chosen lesson, call `propose_memory` (not `remember`) with:

- `title`, `body`, `tags`, `applies_to` — derived from the candidate.
- `conv_id` — the harness conversation id (so the server can resolve `domain` from `conv_state`).

Protected categories (identity, relationship) are routed through the existing proposal flow automatically by the classifier worker; nothing extra to do here.

## Report

Tell the user how many lessons landed as proposals and where they can review them ([dashboard /proposals](http://localhost:3838/proposals) or `/lib-session-list` etc.).
