---
name: use-the-librarian
description: Use The Librarian MCP memory server for disciplined long-term agent memory. Trigger this skill whenever an agent has access to The Librarian MCP tools, needs to recall user identity or relationship context, starts a meaningful conversation or task, learns durable project/tool/environment/user preferences, needs to propose protected identity or relationship memories, or must update/verify memories.
---

# Use The Librarian

## Prime Directive

Use The Librarian as the only long-term memory funnel. Do not maintain competing ad hoc memory files unless the user explicitly asks. Treat memory as a governed system: recall before relying on assumptions, save only durable value, propose protected context, and verify usefulness so the recall ranking improves over time.

Memories live in one of three states:

- `active` — the default, returned by `recall`
- `proposed` — protected category awaiting user approval
- `archived` — no longer surfaced by default recall

A memory is archived for one of several reasons (rejected proposal, agent verified it as outdated, admin archived it) — there is no separate `deleted`, `rejected`, or `conflicted` state.

The Librarian returns clean prose context for agent use. Do not expose raw metadata to the user unless asked.

Use `guybrush` as the `agent_id` for all interactions with The Librarian MCP memory server.

## Required Start Behavior

At the start of every meaningful interaction, call `start_context`.

Use a concise `task_summary` that reflects the actual work, not a generic phrase. Include `project_key` when the conversation concerns a repo, workspace, tool, client, or long-running project.

```json
{
  "agent_id": "guybrush",
  "project_key": "the-librarian",
  "task_summary": "Implement MCP memory skill and dashboard behavior"
}
```

After reading the result, let it influence your behavior silently. Mention memory only when it materially affects a decision, when the user asks, or when there is a proposal awaiting approval.

If `start_context` is unavailable, say briefly that The Librarian tools are unavailable and continue without pretending to have memory.

## Recall Discipline

Use `recall` whenever relevant memory could change how you work.

Recall especially for:

- non-trivial coding, writing, research, planning, or debugging tasks
- project-specific conventions, prior failures, setup quirks, and open threads
- user preferences about tone, workflow, review style, implementation style, or collaboration
- tool or environment behavior that may be machine-specific
- uncertainty about whether something has already been learned

Use targeted queries. A good query names the task, domain, and likely category.

```json
{
  "agent_id": "guybrush",
  "query": "dashboard editing protected memory proposal workflow",
  "categories": ["projects", "tools", "lessons", "preferences"],
  "project_key": "the-librarian",
  "include_private": true,
  "limit": 8
}
```

Do not over-recall. If the task is tiny and `start_context` already covers it, proceed.

## What To Remember

Save memory only when it is likely to be useful in future sessions.

Good memories are:

- durable: likely to remain true beyond the current exchange
- specific: names the project, tool, preference, or situation
- actionable: changes what an agent should do later
- scoped: common vs private, global vs project/tool/environment/session
- concise: one idea per memory

Poor memories are:

- raw transcripts or blow-by-blow task logs
- obvious facts any capable agent can infer
- temporary status better suited to the current context window
- vague impressions with no future action
- secrets, credentials, or sensitive data not explicitly intended for memory

Prefer several crisp memories over one sprawling summary.

## Categories

Use these categories consistently:

- `identity`: who the user is, durable self-concept, life context, values
- `relationship`: how the user wants agents to relate to them
- `preferences`: stable preferences about communication, workflow, tooling, style
- `projects`: project goals, architecture, conventions, decisions, open direction
- `environment`: local machine, OS, shell, paths, runtime quirks
- `tools`: behavior of tools, MCP servers, libraries, CLIs, agent harnesses
- `lessons`: reusable discoveries from success or failure
- `people`: information about named people other than the user
- `open_threads`: durable unresolved threads that should be resumed later

If unsure between categories, choose the category that determines retrieval. For example, a Jest quirk in one repo is `projects`; a Node runtime quirk on the machine is `environment`; a general lesson about MCP tool behavior is `tools` or `lessons`.

## Visibility

Use `common` when the memory should be available to all agents.

Use `agent_private` when the memory is about this agent's own operating behavior, limitations, or learned strategy and should not shape every agent.

Examples:

- Common: "The user prefers implementation-first help for coding tasks."
- Agent-private: "Guybrush should run `rg --files` first in this repo because the workspace is sparse."

Do not hide user-relevant preferences in private memory merely because this agent noticed them.

## Protected Memory

Never directly activate `identity` or `relationship` memories. Use `propose_memory` or let `remember` create a proposal.

Also propose rather than directly write when a preference is emotionally significant, identity-adjacent, relationship-defining, or likely to affect many future conversations.

Direct-write ordinary operational preferences and technical lessons.

Protected examples:

```json
{
  "agent_id": "guybrush",
  "title": "User wants memory to preserve relational continuity",
  "body": "The user wants long-term memory to protect identity and relationship context rather than letting technical trivia crowd it out.",
  "category": "relationship",
  "visibility": "common",
  "scope": "global",
  "priority": "core",
  "confidence": "working",
  "tags": ["memory", "relationship", "continuity"]
}
```

Operational direct-write example:

```json
{
  "agent_id": "guybrush",
  "title": "The Librarian stores memories as a git-backed markdown vault",
  "body": "In the-librarian, memories are plain markdown notes in a git vault (a commit per write); recall runs over a disposable in-memory index rebuilt from the vault. There is no SQL database.",
  "category": "projects",
  "visibility": "common",
  "scope": "project",
  "project_key": "the-librarian",
  "priority": "high",
  "confidence": "strong",
  "tags": ["storage", "markdown", "vault"]
}
```

## Write Workflow

Before calling `remember` or `propose_memory`, ask:

1. Will this matter in a future session?
2. Can it be stated as one clear memory?
3. What category and scope will make it retrievable?
4. Should all agents see it, or only this agent?
5. Is it protected or sensitive enough to require proposal?

Then write the smallest useful memory.

Use `remember` for active technical, project, environment, tool, lesson, people, open-thread, and ordinary preference memories.

Use `propose_memory` for protected or user-review-worthy memories.

Write the smallest useful memory. You do **not** need to `recall` or search for existing memories first to avoid duplicates — the curator/consolidator de-duplicates, merges, and supersedes for you, asynchronously.

## Consolidation is automatic

When the consolidator is enabled, `remember` is fire-and-forget: it returns `queued for consolidation` (no `duplicates` list), and the curator later navigates, judges, merges, and supersedes your submission as it grooms the corpus. You do not hand-consolidate.

On a legacy install with the consolidator off, `remember` saves directly and may return a `duplicates` list — that's informational, never a refusal. You generally don't need to act on it; reserve `update_memory` / `verify_memory result=outdated` for genuine corrections (see below), not as a manual dedup pass. (The `resolve_conflict` verb is retired.)

## Update and Verify

Use `update_memory` when the memory remains useful but needs correction, clearer wording, better scope, or better priority.

Use `verify_memory` after a memory materially helped, misled you, or turned out to be stale. The verdict is load-bearing:

- `useful` — usefulness_score += 1 (clamped to +3). The memory ranks higher in future recall.
- `not_useful` — usefulness_score -= 1 (clamped to -3). Ranks lower.
- `outdated` — the memory is archived. It drops out of default recall.

```json
{
  "agent_id": "guybrush",
  "memory_id": "mem_...",
  "result": "outdated",
  "note": "The repo no longer uses that test command."
}
```

If the memory should stop appearing but isn't actually stale (e.g. it covered a project that no longer matters), an admin can call `archive_memory` directly.

Do not use verification as a truth oracle. It records utility and maintenance signals.

## Priority And Confidence

Set `priority` by future impact:

- `core`: identity, relationship, or foundational project constraints
- `high`: likely to affect many future tasks
- `normal`: useful but routine
- `low`: niche or speculative

Set `confidence` honestly:

- `strong`: directly observed and stable
- `working`: useful current belief
- `tentative`: plausible but uncertain

Prefer `tentative` plus a clear body over pretending certainty.

## Scope And Project Keys

Use `scope` precisely:

- `global`: applies broadly
- `project`: applies to a specific repo/project
- `environment`: applies to machine/runtime/shell/OS
- `tool`: applies to a tool or service
- `session`: only use for durable open threads that must survive context loss

Use a stable `project_key`, usually the repo or project name. For file-system projects, prefer the repo folder name unless the user has a better name.

## Open Threads

Use `open_threads` sparingly for unresolved work that should be resumed later. Include the next concrete action. Delete or archive the memory when the thread is closed.

Good:

> The dashboard needs auth before remote exposure. Next step: choose auth/proxy strategy.

Bad:

> We worked on the dashboard today.

## User Communication

Do not narrate every memory operation. The user wants better continuity, not constant bookkeeping.

Tell the user when:

- you propose identity or relationship memory
- a memory changed an important decision
- you cannot access The Librarian
- you saved something unusually important

Keep it brief.

## Minimal Tool Map

- `start_context`: required task-start context
- `recall`: targeted search
- `remember`: submit a memory. With the consolidator on it's queued for async consolidation (the curator dedupes/merges); otherwise it saves directly. Protected categories become proposals.
- `propose_memory`: submit protected or review-worthy memory
- `update_memory`: edit while preserving history
- `verify_memory`: useful (+1), not_useful (-1), outdated (archive)
- `list_proposals`: inspect pending proposals
- `archive_memory`: admin-only — agents should prefer `verify_memory result=outdated`
- `approve_proposal`: admin-only approve, edit, or reject proposed memory

Use memory to improve the work, not to replace judgment.
