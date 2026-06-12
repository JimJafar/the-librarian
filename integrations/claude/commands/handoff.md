---
description: Store a handoff document for cross-agent / cross-harness pickup
---

Author a five-section handoff document and persist it via the `store_handoff` MCP tool. The receiving agent (any harness) claims it with `/takeover` in the same `cwd` and same project.

## Privacy gate

Before doing anything else, scan the conversation for the most recent `[librarian:private=on|off]` marker. If it is `on`, ask the user to confirm explicitly that they want this conversation's content written to a handoff. Abort on "no".

## Authoring

Read the full transcript via the harness's native API; fall back to the in-context view if no transcript API is available. Produce a Markdown document conforming to this template — **the headings are part of the contract and are validated by the MCP tool**:

```markdown
# Handoff: <title>

## Start & intent
<what the user came in wanting; why; constraints>

## Journey
<compressed timeline: decisions made (and why), alternatives considered and rejected, deferred work / parking lot, dead ends / lessons learned>

## Current state
<where we are right now — files touched, branches, open PRs, what works, what doesn't, known gotchas>

## What's left
<concrete next steps, in order, with enough context to start cold>

## Open questions
<things needing human decision before next step>
```

Pick a title that summarises the work in ≤ 80 chars.

## Call

Invoke `store_handoff` with:

- `title` — ≤ 80 chars
- `document_md` — the rendered template
- `project_key` — inferred from the project's agent-instructions file / project root
- `cwd` — current working directory
- `harness` — the harness you are running in (e.g. `"claude-code"`, `"opencode"`)
- `source_ref` — a stable reference to where the work happened: the harness conversation/run id if one is available, else `cwd:<absolute path>`
- `tags` — short tags only when they help disambiguate (e.g. `["migration", "p1"]`)

## Report back

Tell the user the `handoff_id` and how to claim it (`/takeover` in any agent on the same cwd).
