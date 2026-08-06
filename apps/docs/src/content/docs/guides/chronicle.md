---
title: The Chronicle
description: Turn each week's activity into a durable, searchable review — with an optional narrative.
---

The **Chronicle** is a weekly review written by The Librarian itself. It gathers
what changed, what the collection learned, and what remains open, then files the
result as a normal Markdown reference. It gives you a durable answer to “what
happened here last week?” without depending on a chat transcript or a model's
memory.

Chronicle is **off by default**. Configure it under **Settings → Curator →
Chronicle**.

## What it writes

Each completed week gets an entry at:

```text
references/chronicle/YYYY-Www.md
```

For example, ISO week 31 of 2026 is
`references/chronicle/2026-W31.md`. Because the entry is a reference, agents can
find it with `search_references`, and you can read, edit, or restore it from the
[Vault](/dashboard/vault/). Re-running the same week updates that week's entry
instead of creating a duplicate.

Every entry has a deterministic digest built from local evidence:

- vault changes committed during the period;
- memories created, updated, proposed, archived, or otherwise changed;
- handoffs created or claimed, plus questions that remain open;
- Intake and Grooming outcomes when those runs can be attributed safely; and
- warnings where the available data cannot support a trustworthy claim.

The evidence appendix is written even when no language model is configured. It
does not invent missing usage figures: for example, Intake token usage is marked
unavailable because Intake's run record does not currently store it.

## Optional narrative

Choose a provider and model in the Chronicle tab if you want a readable narrative
and up to three possible blog seeds above the factual digest. This step is
optional and fail-soft: an unavailable provider, malformed response, or narration
error still produces the deterministic entry and records the run as **Digest
only**.

Before facts are sent to the configured provider, secret-shaped values are
redacted across the complete payload and the prompt is bounded. The provider
token itself is never placed in the prompt or logs.

## Schedule and Run now

The default schedule is Monday at 08:00 in the server's local time, but it does
nothing until you enable it. A scheduled run reviews the **previous completed
week**. If the server misses the chosen time, it catches up on the next scheduler
poll rather than skipping the week.

**Run Chronicle now** is deliberately different: it writes a **partial review of
the current week**, even while the automatic schedule is disabled. The entry and
run history are labelled partial so they cannot be mistaken for a completed week.

## Shelves and privacy boundaries

Chronicle writes one entry per writable system shelf. It never mixes facts from
different shelves into one review. On the standard single-shelf installation
this simply means one entry in your vault.

On a multi-shelf installation, vault-global Intake and Grooming aggregates are
omitted because their current run records cannot be attributed reliably to a
single shelf. The entry says so instead of guessing. Read-only shelves are
skipped.

## Reading the run history

The Chronicle tab records the ISO week, shelf, trigger, completion status,
narration mode, model, token usage, entry path, and a value-free failure label.
The server log contains only the same operational counts and outcome metadata —
never memory text, handoff text, prompts, or the generated narrative.
