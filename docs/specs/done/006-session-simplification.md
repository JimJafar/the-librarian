# Spec: Session simplification

## Status

Implemented 2026-05-21 (S1.1 in PR #49, S1.2 in PR #50, S1.3 in this PR).

## Objective

Cut the session lifecycle down to what the user actually needs. Concretely:

- Collapse the five session statuses (`active`, `paused`, `ended`, `archived`, `deleted`) into three: `active`, `paused`, `ended`. `ended` already hides from default `list_sessions` — `archived` and `deleted` were two more ways to say the same thing.
- `list_sessions` defaults to `active + paused`. Ended sessions opt-in via `--include-ended`. (Today's default returns active + paused + ended, which is noisy.)
- Drop `archive_session`, `restore_session`, `delete_session` MCP tools. `end_session` covers all three intents — formal completion (with summary), abandonment (no summary), and "delete" (still no summary; soft-state is soft-state).
- `resume_session` works on `ended` sessions too. Replaces `restore` — if you ended prematurely and want to keep going, just resume.
- Drop `/lib-session-status` slash command — `/lib-session-list` filtered by current harness/cwd does the same job.
- Drop `/lib-session-archive`, `/lib-session-restore`, `/lib-session-delete` slash commands.
- Fix `/lib-session-resume` so it does the list+select flow inline when called with no arg — no more "you have to run list first."
- Keep `checkpoint_session` — it's the one verb that updates `rolling_summary` mid-session without changing state. Cheap, useful, will pair with the auto-checkpoint hook idea (TODO #12).

**Success means:** an agent (or user via slash) can start a session, do work, optionally checkpoint, pause or end it, and later resume it — all without needing to learn the difference between archived/deleted/ended or remember a separate "list then resume" two-step.

## Non-goals

- **Not changing the storage architecture.** Sessions stay on JSONL-canonical + SQLite projection for this spec. The shift to SQLite-canonical is its own (much larger) spec — see `specs/009-session-storage-rearchitecture.md` if/when drafted.
- **Not adding a hard-purge tool.** Even soft-deleted sessions stay in `sessions.jsonl` today; that won't change here. A real `purge_session` admin tool belongs with the storage rearchitecture.
- **Not redesigning handover formatting.** `continue_session` and the per-harness handover formats are unchanged.
- **Not adding new visibility states.** `common` / `agent_private` stays. `harness_private` is still deferred (TODO #9).
- **Not adding new event-payload types.** Notes, decisions, commands, files, errors, questions, attachments stay the same shape.

## Decisions (resolved)

- **Three statuses: `active | paused | ended`.** Remove `SessionStatus.Archived` and `SessionStatus.Deleted` from `packages/core/src/schemas/common.ts`. The corresponding event-type variants (`session.archived`, `session.deleted`, `session.restored`) stay in the projection's discriminated union so old `sessions.jsonl` lines parse; their handlers map to the new state model:
  - `session.archived` → `status: ended`
  - `session.deleted` → `status: ended`
  - `session.restored` → `status: paused`
- **`end_session` accepts an optional summary.** Existing required-summary callsites pass through. New "I'm just hiding this" use cases pass nothing.
- **`resume_session` works on `ended`.** `attachSession` and `continueSession` change `assertSessionMutable` to allow `ended` as well as `active`/`paused`. Resuming an ended session sets status back to `paused` (caller can immediately record an event to flip to active).
- **`list_sessions` default `[active, paused]`.** Add `--include-ended` (CLI), `include_ended: true` (MCP/tRPC input) for the opt-in. The historical `--include-archived` and `--include-deleted` flags are dropped as inputs but accepted-and-ignored for one release so older callers don't break loudly. (Spec note: revisit "accepted-and-ignored" once integrations are confirmed updated.)
- **Drop MCP tools and tRPC procedures:** `archive_session`, `restore_session`, `delete_session` (MCP); `sessions.archive`, `sessions.restore`, `sessions.delete` (tRPC). Dashboard's LifecycleActions component loses the three buttons.
- **Drop slash commands:** `/lib-session-status`, `/lib-session-archive`, `/lib-session-restore`, `/lib-session-delete`. Files removed from `integrations/*/commands/`.
- **`/lib-session-resume` inline-list-and-select.** When invoked with no argument, the skill calls `list_sessions`, renders the numbered list, and asks which to resume — no more "run list first" prompt. When invoked with a number, resolve against the most recent in-conversation list. When invoked with a `ses_...` id, resolve directly.
- **`/lib-session-list` describes the default filter.** Skill text updated to mention `--include-ended` for cross-checking older work.

## Tech stack

No new dependencies. Changes inside:

- `@librarian/core` — schemas (drop two enum values), session-store (drop three methods, adjust list defaults, allow ended in mutable-checks), projection (map historical events).
- `@librarian/mcp-server` — drop three tool files + their registry entries, drop three tRPC procedures.
- `apps/dashboard` — LifecycleActions component (drop three buttons), sessions list (default filter), session detail (resume button works on ended).
- `integrations/<harness>/commands/` — drop four `.md` files per harness that ships per-verb commands (Claude Code, OpenCode), update Hermes single-command docs.
- `skills/use-the-librarian/SKILL.md` — agent-facing guidance.

## Migration plan (phases)

Each phase is one PR. Each phase leaves `main` releasable. Phases land serially.

### Phase 1 — Core state collapse + API/UI cleanup (S1.1)

The biggest PR. State collapse, tool removal, dashboard cleanup ship together because they're interlocked (changing state without removing the now-unbacked tools would leave the system inconsistent).

**Core:**

- Remove `SessionStatus.Archived` and `SessionStatus.Deleted` from `packages/core/src/schemas/common.ts`. After this: `SessionStatus = active | paused | ended`.
- Update the projection (`packages/core/src/store/projection.ts`):
  - `session.archived` → `status: ended` (was `archived`).
  - `session.deleted` → `status: ended` (was `deleted`). Clear `deleted_at`.
  - `session.restored` → `status: paused` (was: whatever `prior_status` was). The `prior_status` column becomes vestigial; can be dropped in the storage rearchitecture spec.
- The event-type variants stay in the discriminated union; no new code emits them.
- `packages/core/src/store/session-store.ts`:
  - Remove `archiveSession`, `restoreSession`, `deleteSession` methods.
  - `listSessions` default status set changes from `[Active, Paused, Ended]` to `[Active, Paused]`. New input flag `include_ended: boolean` adds `Ended` to the set. `include_archived` / `include_deleted` flags removed from the type but the function accepts unknown extras silently (no-op) for one release.
  - `assertSessionMutable` accepts `active | paused | ended` instead of `active | paused`. `endSession` makes `summary` optional (already optional in practice; document and verify).
  - `attachSession` and `continueSession` both work on ended sessions — resuming sets `status: paused`.

**MCP tools:**

- Delete `packages/mcp-server/src/mcp/tools/archive-session.ts`, `restore-session.ts`, `delete-session.ts`. Remove from `tools/index.ts`.
- Update `list-sessions.ts` schema: drop `include_archived` / `include_deleted` from `inputSchema.properties`, add `include_ended`. Update the description.
- Update `end-session.ts`: make `summary` optional in the schema.

**tRPC:**

- Delete `sessions.archive`, `sessions.restore`, `sessions.delete` procedures in `packages/mcp-server/src/trpc/sessions.ts`. Remove their input shapes.
- Update `sessions.list` Zod input: drop `include_archived` / `include_deleted`, add `include_ended`.
- Update `sessions.end` input: make `summary` optional.

**Dashboard:**

- `apps/dashboard/components/sessions/lifecycle-actions.tsx` — drop the Archive, Restore, Delete buttons. Keep Checkpoint, Pause, End, Resume. Make Resume visible when status is `paused` OR `ended` (was: paused only).
- `apps/dashboard/components/sessions/list-view.tsx` and the sessions list page — update the default filter (active + paused) and add an "Include ended" toggle.
- `apps/dashboard/app/sessions/[id]/actions.ts` — remove the three obsolete Server Actions; update list query input.
- Component tests under `apps/dashboard/tests/components/` updated for the new button set.

**Storage fixture + guards:**

- `scripts/check-storage-fixture.mjs` projection counts updated for the new state model (any old `archived` / `deleted` rows in the fixture now project to `ended`).
- `scripts/check-schema-version.mjs` sentinel bumped.

**Tests:**

- Projection: replay a fixture with `session.archived`, `session.deleted`, `session.restored` events; assert the rebuilt projection has `status` ∈ `{ended, paused}` per the mapping rules.
- Session store: `list_sessions` default returns only active + paused; `include_ended: true` adds ended; archived/deleted statuses never appear post-rebuild.
- MCP integration: `tools/list` no longer contains `archive_session`, `restore_session`, `delete_session`. `end_session` accepts no-summary input. `attach_session` / `continue_session` work on an ended session and transition it to paused.
- tRPC: dropped procedures return 404 / TRPCError; `sessions.list` `include_ended` round-trips.
- Dashboard component: LifecycleActions renders only the new button set; Resume appears on ended.
- E2E: a session can be ended (no summary) and then resumed via the dashboard. No archived / deleted tab in the sidebar.

**Acceptance:** zero references to `SessionStatus.Archived` or `SessionStatus.Deleted` in production source; zero references to `archiveSession`/`restoreSession`/`deleteSession`/`archive_session`/`restore_session`/`delete_session`; `tools/list` shows 8 session tools (was 11); dashboard LifecycleActions has 4 buttons (was 7); rebuild from existing canonical-instance `sessions.jsonl` doesn't break.

### Phase 2 — Slash commands + skill cleanup (S1.2)

User-facing surface aligns with the new tool set.

**Per-harness command files:**

- `integrations/claude-code/commands/` — delete `lib-session-status.md`, `lib-session-archive.md`, `lib-session-restore.md`, `lib-session-delete.md`.
- `integrations/opencode/commands/` — same four deletions.
- `integrations/hermes/` — update the single-command parser docs to drop those four verbs.

**Updated commands:**

- `lib-session-resume.md` (Claude Code, OpenCode) — when invoked with no argument, the agent should:
  1. Call `list_sessions` scoped to current harness/cwd.
  2. Render the numbered list.
  3. Ask the user to pick by number or `ses_...` id.
  4. Resolve the choice and proceed with the existing resume flow.
  No more "you have to run /lib-session-list first" prompt.
- `lib-session-list.md` (Claude Code, OpenCode, Hermes) — document the new default (active + paused) and the `--include-ended` opt-in.
- `lib-session-end.md` (Claude Code, OpenCode, Hermes) — clarify that summary is optional. "End without summary" is the abandonment path.

**Skill:**

- `skills/use-the-librarian/SKILL.md` — describe the three-state model. Drop the section on archived/deleted/restored. Update the resume flow.

**Cross-harness contract:**

- `docs/slash-commands.md` — update the verb table. Drop status/archive/restore/delete rows. Add notes on the resume inline-list flow and the `--include-ended` opt-in.

**Tests:**

- The integration wrapper smoke tests already shell out to `the-librarian sessions <verb>` — confirm none of them call the dropped verbs. Adjust any that do.
- CLI snapshot tests under `packages/cli/tests/snapshots.test.ts` — drop snapshots for the removed CLI subcommands (`sessions archive`, `sessions restore`, `sessions delete`) if present.

**Acceptance:** `rg "lib-session-archive|lib-session-restore|lib-session-delete|lib-session-status" integrations/` returns zero hits. `/lib-session-resume` with no arg invokes the inline list-and-select flow (verified manually in a Claude Code session). `docs/slash-commands.md` matches the MCP tool list.

### Phase 3 — Docs polish (S1.3)

The writing.

- `README.md` — Sessions section: update lifecycle description, drop archived/deleted references, update the MCP tools list, update the CLI examples (drop archive/restore/delete commands).
- `CONTRIBUTING.md` — the "new CLI verb" section already lives there. No edits needed unless a verb-specific example references a dropped one.
- `TODO.md` — items #9 (`harness_private`), #10 (purge), #11 (`session.split`/`merged`), #13 (storage rearchitecture) stay; this spec doesn't address them. Mark the slash-command verbs status/archive/restore/delete as removed in a "Resolved" section.
- `specs/006-session-simplification.md` (this file) status → "Implemented YYYY-MM-DD".

**Acceptance:** stranger walkthrough — read the README's Sessions section, can you describe what `start`, `checkpoint`, `pause`, `end`, `resume` do in one sentence each, and confirm there's no archived/deleted concept?

## Summary

| Phase | PR | What |
|---|---|---|
| 1 | S1.1 | Core state collapse + drop 3 MCP tools + drop 3 tRPC procedures + dashboard cleanup |
| 2 | S1.2 | Drop 4 slash commands + update resume skill + update list/end skills |
| 3 | S1.3 | Docs polish (README, TODO, slash-commands.md) |

3 PRs, serial. Each leaves `main` releasable.

## Open questions

- **The `prior_status` column in the projection** becomes vestigial after `session.restored` always sets `paused`. Drop it as part of S1.1 or leave for the storage rearchitecture? — Leaning leave; the column is harmless and the rearchitecture will rewrite the schema anyway.
- **CLI `the-librarian sessions <verb>` parity.** The CLI has `sessions archive`, `sessions restore`, `sessions delete` commands today. Drop them in S1.1 alongside the MCP tools, or in S1.2 alongside the slash commands? — S1.1, because the CLI invokes the store methods directly; once the store methods are gone the CLI commands won't compile.

## Acceptance review (for this spec)

- Does collapsing `ended` / `archived` / `deleted` into one state lose any information operators currently rely on? — Probably not; the "I ended this formally" vs "I gave up" distinction is encoded by whether `end_summary` is present, not by a separate status. If an operator wants to know which sessions had end summaries, they can filter on that field.
- Is `checkpoint` really worth keeping as a separate verb vs collapsing into "record_session_event with type=checkpoint"? — Yes; checkpoint's projection handler updates the `rolling_summary` column, which is a column-level concern, not just an event timeline thing. Keeping a dedicated verb makes the intent explicit and the implementation cleaner.
- Should the dashboard's "Include ended" toggle persist across visits (cookie / localStorage)? — Out of scope here; UI redesign (#15) is the natural home for that decision.
