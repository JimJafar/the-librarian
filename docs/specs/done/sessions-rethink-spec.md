---
title: Sessions rethink — implementation spec
status: ready-for-plan
spec_version: 1.1
started: 2026-05-28
revised: 2026-05-28
related_doc: sessions-rethink.md
---

# Sessions rethink — implementation spec

> Spec derived from `sessions-rethink.md` (12 decisions, 14-scenario walk). This document is the implementation contract — code conforms to it; deviations require updating the spec first.
>
> **v1.1 revision (2026-05-28):** independent review surfaced a curator-coupling blind spot, a D9↔§6.1 misalignment, broad UI/CLI/infra cleanup gaps, and several over-engineering items. All addressed in this revision. The biggest structural addition is §12 (curator decoupling).

---

## 1. Objective

Replace The Librarian's session subsystem (13 MCP tools, event-sourced storage, hook-driven auto-capture in two plugins) with a minimal handoff/learn/private surface.

**The change is a net deletion.** Three new MCP tools, four user-facing slash commands per harness, one new SQLite table — in exchange for the removal of ~13 tools, four hook-driven plugins' session machinery, a session-events ledger, an audit table, and a projection layer.

### User stories

- **As a developer continuing work on another machine,** I run `/handoff` in my current agent, switch machines, run `/takeover` in any harness in the same cwd, and the new agent picks up with a five-section narrative of where I left off.
- **As a developer finishing a session,** I run `/learn` and the agent extracts candidate lessons from the conversation; I multi-select; the chosen ones become durable memories via the existing `remember`/`propose_memory` flow.
- **As a developer with sensitive context,** I run `/toggle-private` and the agent stops writing to durable memory until I toggle back; if I then invoke `/handoff` or `/learn`, the agent prompts me to confirm consent explicitly.

### Success criteria

- [ ] `pnpm test` (monorepo) green; `bun test` (opencode plugin) green; `npm run typecheck` green in all plugin repos.
- [ ] `the-librarian` MCP server exposes exactly three new tools (`store_handoff`, `list_handoffs`, `claim_handoff`) and zero session tools (`start_session`, `get_session`, `list_sessions`, `list_session_events`, `record_session_event`, `checkpoint_session`, `pause_session`, `end_session`, `attach_session`, `continue_session`, `search_sessions`, `promote_session_fact`, `purge_session`).
- [ ] The `handoffs` table exists with the schema in §6.2; the tables `sessions`, `session_events`, `session_state_changes`, `session_events_fts` (and FTS5 shadow tables) do not exist.
- [ ] The curator no longer reads sessions: no references to `gatherSessionEvidence`, `SessionEvidenceBundle`, `source_session_ids`, `input_session_ids`, `min_sessions_since_run` anywhere in `packages/core/src/curator-*.ts` or `packages/core/src/store/curation-store.ts`. (See §12.)
- [ ] All six repos have `/handoff`, `/takeover`, `/learn`, `/toggle-private` as native slash commands (or equivalent for Hermes/Pi if they expose a command surface).
- [ ] All session-related hook code is removed from `the-librarian-claude-plugin`, `the-librarian-codex-plugin`, `the-librarian-opencode-plugin`.
- [ ] All natural-language private-mode detection code is removed (`privacy-detector.ts`, `privacy_gate.py`, `privacy.py`, `privacy.ts`) — replaced by `/toggle-private` per D2.
- [ ] Pi extension's session surface (`session-client.ts`, event wiring in `index.ts`, `harnessSessionKey` in `config.ts`, `conv-state-render.ts` session refs) is removed; Hermes' session commands and `state.py` are removed.
- [ ] Dashboard at `apps/dashboard` has a read-only Handoffs page (list + detail); all `app/sessions/` routes, `components/sessions/` directory, session nav entries, command-palette / keybinding references, and `e2e/sessions.spec.ts` are removed.
- [ ] An end-to-end smoke test demonstrates: Claude `/handoff` → claim from OpenCode `/takeover` → document arrives in second agent's context.
- [ ] Each scenario A–N from `sessions-rethink.md §9` is covered by at least one integration test.
- [ ] No code references `HandoverPayload`, `SessionEventRow`, `SessionEventEnvelope`, `SessionEventType`, `aggregateHandoverInputs`, `rolling_summary`, `capture_mode`, `LIBRARIAN_SESSION_ID`.
- [ ] `scripts/healthcheck.js` allow-list updated; `scripts/check-test-count.mjs` baseline updated; `scripts/check-session-state-divergence.mjs` and `scripts/migrate-sessions-to-authoritative-sqlite.mjs` deleted along with `test/r2-sessions-migration.test.ts`.

---

## 2. Tech stack

Inherited from existing repos — no new tech:

| Repo | Stack | Test runner | Build |
|---|---|---|---|
| `the-librarian` | TypeScript, Node ≥20, pnpm workspaces | Vitest | tsc (per-package) |
| `the-librarian-claude-plugin` | TypeScript, Node ≥20 | None (smoke only) | esbuild bundle |
| `the-librarian-codex-plugin` | JavaScript (.mjs), Node ≥20 | None (smoke only) | n/a |
| `the-librarian-opencode-plugin` | TypeScript, Bun | `bun test` | n/a |
| `the-librarian-hermes-plugin` | Python ≥3.10 | pytest | n/a |
| `the-librarian-pi-extension` | TypeScript, Node ≥20 | (TBD — check repo) | (TBD) |

Storage: SQLite (existing). New table joins the existing `memories`, `proposed_memories`, etc. No new dependencies.

---

## 3. Commands

### Monorepo (`~/code/the-librarian`)

```
pnpm install                    # one-time
pnpm typecheck                  # type-check all packages
pnpm build                      # build all packages
pnpm test                       # full test suite (vitest)
pnpm lint                       # eslint
pnpm lint:fix                   # eslint --fix
pnpm format:check               # prettier --check
pnpm format                     # prettier --write
pnpm smoke                      # local smoke test
pnpm dashboard                  # start dashboard (Next.js)
pnpm --filter @librarian/mcp-server serve   # MCP server only
pnpm --filter @librarian/cli rebuild        # rebuild CLI
```

### Plugin repos

```
# claude-plugin
npm run typecheck && npm run build && npm run validate && npm run smoke

# codex-plugin
node bin/validate.mjs && node bin/smoke.mjs

# opencode-plugin
bun run typecheck && bun test && bun run validate && bun run smoke

# hermes-plugin
pytest

# pi-extension
(per repo conventions — check package.json scripts)
```

### Verification gates (must pass before each PR merges)

```
pnpm typecheck && pnpm lint && pnpm test && pnpm smoke
```

---

## 4. Project structure

> **Read this section against actual code, not from memory.** v1.0 understated the deletion blast radius materially; the lists below were corrected against `rg`-based scans of all six repos.

### Files to **add**

#### `the-librarian` (monorepo)

```
packages/core/src/schemas/handoff.ts                    # Zod schema + types
packages/core/src/store/handoff-store.ts                # CRUD + atomic claim
packages/core/src/store/handoff-store.test.ts           # unit tests

packages/mcp-server/src/mcp/tools/store-handoff.ts
packages/mcp-server/src/mcp/tools/list-handoffs.ts
packages/mcp-server/src/mcp/tools/claim-handoff.ts
packages/mcp-server/tests/mcp/handoffs.mcp.test.ts

packages/cli/src/commands/handoffs-list.ts              # NB: CLI verbs are top-level, no subdirectory
packages/cli/src/commands/handoffs-show.ts
packages/cli/src/commands/handoffs-purge.ts             # admin

apps/dashboard/app/handoffs/page.tsx                    # list view
apps/dashboard/app/handoffs/[id]/page.tsx               # detail view
apps/dashboard/tests/components/handoffs.test.tsx       # NB: dashboard tests live under tests/components/, not colocated

.claude/commands/handoff.md
.claude/commands/takeover.md
.claude/commands/learn.md
.claude/commands/toggle-private.md
```

Schema DDL lives inline in `packages/core/src/store/projection.ts`'s `initSchema` path (where existing tables are created); no separate `.sql` file. See §6.4.

#### Each plugin repo

Native command files for the four verbs. Locations match each plugin's existing convention:

```
the-librarian-claude-plugin/commands/{handoff,takeover,learn,toggle-private}.md
the-librarian-codex-plugin/commands/{handoff,takeover,learn,toggle-private}.md
the-librarian-opencode-plugin/commands/{handoff,takeover,learn,toggle-private}.md
the-librarian-hermes-plugin/   (extend commands.py with four new subcommands)
the-librarian-pi-extension/extensions/librarian/commands.ts   (extend existing command registry — replace seven lib-session-* entries with four new ones)
```

### Files to **delete**

#### `the-librarian` — core + curator

```
# Session storage layer
packages/core/src/store/session-store.ts
packages/core/src/store/session-store.test.ts
packages/core/src/store/projection.ts                  # rewritten, not deleted — see below
packages/core/src/schemas/session.ts
packages/core/src/formatters/prose.ts                  # session-prose only consumer
packages/core/src/caller-backfill.ts                   # session-table backfill — rewrite to memory-only or delete
packages/core/src/backup/backup.ts                     # remove session_events.jsonl + sessions.legacy.jsonl archiving
packages/core/src/backup/restore.ts                    # update tolerance for missing legacy files

# Curator session coupling (see §12 for the full picture)
packages/core/src/curator-evidence.ts                  # gatherSessionEvidence, SessionEvidenceBundle, etc.
packages/core/src/curator-redaction.ts                 # session-summary redaction (if no other consumer)
# Files modified, not deleted:
#   curator-worker.ts, curator-prompt.ts, curator-output.ts, curator-validate.ts,
#   curator-apply.ts, curator-schedule.ts, curator-scheduler.ts, store/curation-store.ts
# (see §12 for the modification surface)
```

`projection.ts` is **rewritten, not deleted**: roughly 1500 lines today, ~60% session-coupled. After the change it becomes memory-only, ~600 lines. The rewrite is its own subtask under PR 1.

#### `the-librarian` — schemas, barrels, MCP, CLI, scripts, docs

```
# Schemas
packages/core/src/schemas/events.ts                    # SessionEventEnvelope, SessionStartedEvent, etc.
packages/core/src/schemas/common.ts                    # KEEP file; DELETE SessionEventType enum (lines 104–113)
packages/core/src/schemas/index.ts                     # KEEP; remove `export * from "./session.js"`
packages/core/src/store/index.ts                       # KEEP; remove `export * from "./session-store.js"`
packages/core/src/index.ts                             # KEEP; remove any session re-exports

# MCP server
packages/mcp-server/src/mcp/tools/{start,get,list,record,checkpoint,pause,end,attach,continue,search,list-session-events,promote,purge}-session*.ts
packages/mcp-server/src/mcp/tools/index.ts             # KEEP; remove the 13 barrel imports
packages/mcp-server/src/mcp/formatters.ts              # KEEP; remove formatSessionDetail, formatSessionEvents (or move to handoff formatter)
packages/mcp-server/src/index.ts                       # KEEP; remove session formatter re-exports
packages/mcp-server/src/trpc/sessions.ts               # whole file
packages/mcp-server/src/trpc/router.ts                 # KEEP; remove sessionsRouter import + composition
packages/mcp-server/tests/mcp/sessions.mcp.test.ts
packages/mcp-server/tests/mcp/recall-domain.mcp.test.ts   # remove session-touching cases
packages/mcp-server/tests/mcp/remember-domain.mcp.test.ts # remove session-touching cases
packages/mcp-server/tests/trpc/memories.test.ts          # remove session-touching cases

# CLI — verbs are top-level, NOT in commands/sessions/*
packages/cli/src/commands/start.ts
packages/cli/src/commands/attach.ts
packages/cli/src/commands/checkpoint.ts
packages/cli/src/commands/continue.ts
packages/cli/src/commands/end.ts
packages/cli/src/commands/events.ts
packages/cli/src/commands/pause.ts
packages/cli/src/commands/search.ts
packages/cli/src/commands/show.ts                     # session show
packages/cli/src/commands/list.ts                     # session list
packages/cli/src/commands/_conv-id.ts
packages/cli/src/commands/_shared.ts                  # session-only helpers
packages/cli/src/commands/index.ts                    # KEEP; remove `sessionVerbs` map (~line 22)
packages/cli/src/runtime.ts                           # KEEP; remove sessions dispatcher (~lines 132, 149–156)

# Slash commands (Claude Code, in the monorepo)
.claude/commands/lib-session-{start,resume,list,checkpoint,pause,end,search}.md
.claude/commands/lib-toggle-private.md                # replaced by /toggle-private

# Scripts
scripts/check-session-state-divergence.mjs
scripts/migrate-sessions-to-authoritative-sqlite.mjs  # leftover R2 migration; obsolete
test/r2-sessions-migration.test.ts                    # test for the above
# scripts/check-test-count.mjs                        # KEEP; update test/baseline.json after PR1 lands
# scripts/healthcheck.js                              # KEEP; remove `session: [...]` allow-list (lines 23–48)

# Docs
docs/slash-commands.md                                # rewrite to four-verb surface
docs/migration-sessions-storage.md                    # obsolete
docs/specs/done/session-layer-and-harness-packages.md # historical — move or delete
docs/specs/done/session-simplification.md
docs/specs/done/session-storage-rearchitecture.md
docs/specs/done/harness-commands-and-lifecycle-spec.md
# docs/adr/                                           # KEEP individual files; flag stale ones for review

# package.json (monorepo root)
# Remove script: "check:session-state-divergence"
```

#### Plugin: `the-librarian-claude-plugin`

```
src/bin/claude-code-hook.ts
src/harness/claude-code.ts                            # strip lifecycle wiring or delete if no other use
src/session.ts
src/privacy.ts                                        # natural-language private detection (D2 retires)
src/state.ts                                          # KEEP only if anything non-session lives here; otherwise delete
src/cli.ts                                            # KEEP; remove toCliSession, listSessions, session methods
src/remote-cli.ts                                     # KEEP; remove session method surface
src/index.ts                                          # KEEP; remove `export * from "./session.js"`
hooks/hooks.json                                      # remove UserPromptSubmit, PostCompact, TaskCompleted, SessionEnd entries; delete file if empty
bin/librarian-claude-hook.js                          # delete or rebuild (it's the compiled bundle)
bin/librarian-mcp-call.js                             # check usage; likely keep
scripts/dispatch.sh                                   # check usage post-hook removal
commands/lib-session-{start,resume,list,checkpoint,pause,end,search}.md
commands/lib-toggle-private.md
skills/use-the-librarian/SKILL.md                     # KEEP file; rewrite to describe new surface
README.md, AGENTS.md, CHANGELOG.md                    # update sections
```

#### Plugin: `the-librarian-codex-plugin`

```
src/handlers/post-compact.mjs
src/handlers/checkpoint-policy.mjs
src/handlers/user-prompt-submit.mjs
src/handlers/session-bootstrap.mjs
src/handlers/session-start.mjs
src/handlers/stop.mjs                                 # check usage post-cleanup
src/dispatch.mjs                                      # collapse to bootstrap-only or delete
src/state-store.mjs                                   # session_id + private persistence
hooks/                                                # remove session hook entries; delete dir if empty
bin/librarian-codex-hook.js                           # rebuild from cleaned source
skills/librarian/SKILL.md                             # rewrite
README.md, AGENTS.md, CHANGELOG.md                    # update
```

#### Plugin: `the-librarian-opencode-plugin`

```
src/handlers/chat-message.ts
src/handlers/session-idle.ts
src/handlers/session-compacted.ts
src/handlers/checkpoint-policy.ts
src/handlers/session-bootstrap.ts
src/handlers/session-created.ts
src/handlers/system-transform.ts                      # check usage; session-coupled per review
src/handlers/ensure-commands.ts                       # verify scope — keep if it bootstraps the new commands
src/state-store.ts
src/privacy-detector.ts                              # natural-language detection (D2 retires)
src/index.ts                                          # collapse event handler to bootstrap
commands/lib-session-*.md                             # all seven
README.md, AGENTS.md, CHANGELOG.md                    # update
```

#### Plugin: `the-librarian-hermes-plugin`

```
commands.py                                           # KEEP; remove session subcommands
client.py                                             # KEEP; remove session-tool methods (start_session, list_sessions, etc.)
provider.py                                           # KEEP; remove start_new_session(), session tool plumbing
state.py                                              # whole file — librarian_session_id, entered_private_at
privacy_gate.py                                       # natural-language detection (D2 retires)
privacy.py                                            # same
README.md, AGENTS.md, CHANGELOG.md                    # update slash-commands tables
```

#### Plugin: `the-librarian-pi-extension`

```
extensions/librarian/session-client.ts                # whole file
extensions/librarian/lifecycle/privacy.ts             # delete (private mode is now in-conversation only per D11)
extensions/librarian/index.ts                         # KEEP; remove createSessionClient, lib-session-* command registrations, pi.on("session_compact"/"session_shutdown"/"session_start") wiring
extensions/librarian/orchestrator.ts                  # KEEP; remove session imports/orchestration
extensions/librarian/memory-tools.ts                  # KEEP; remove session-related helpers
extensions/librarian/config.ts                        # KEEP; remove harnessSessionKey, CaptureMode import
extensions/librarian/conv-state-render.ts             # KEEP; remove session_id rendering
extensions/librarian/commands.ts                      # KEEP; replace lib-session-* registrations with handoff/takeover/learn/toggle-private
extensions/librarian/handlers/system-prompt-augment.ts # KEEP; remove off-record session comment + session-key construction if redundant
README.md, AGENTS.md, CHANGELOG.md                    # update
```

#### Dashboard (`apps/dashboard`)

```
app/sessions/page.tsx
app/sessions/[id]/page.tsx
app/sessions/[id]/actions.ts
components/sessions/list-view.tsx
components/sessions/detail-view.tsx
components/sessions/events-stream.tsx
components/sessions/handover-form.tsx
components/sessions/lifecycle-actions.tsx
components/sessions/promote-form.tsx
components/sessions/types.ts
e2e/sessions.spec.ts
tests/components/lifecycle-actions.test.tsx
# Files to modify (not delete):
components/site-nav.tsx                              # nav entry: /sessions → /handoffs
components/keyboard-host.tsx                         # nav-sessions target, trpc.sessions.list query, "s" keybinding
components/ui-v2/command-palette.tsx                 # placeholder text + comments
components/ui-v2/inspector.tsx                       # comment-level
app/layout.tsx                                       # page description
tests/components/site-nav.test.tsx                   # update for new nav entry
tests/components/keyboard-host.test.tsx              # update for new keybinding
```

### Files to **modify** (cross-cutting)

- `docs/slash-commands.md` — replace `/lib:session <verb>` family with the new four.
- `README.md` in every repo — update sections referencing sessions.
- `AGENTS.md` in every repo — update guidance.
- `CHANGELOG.md` in every repo — describe the breaking change including the curator decoupling and backup format change.
- `scripts/check-test-count.mjs` baseline (`test/baseline.json`) — update count after PR 1.
- All `package.json` files that reference removed scripts.
- Operator-side stale artefacts on disk: `session_events.jsonl`, `sessions.legacy.jsonl` in the data directory. On boot, if present, rename to `<name>.predeprecation.bak` and log a one-line warning so operators can manually delete or archive. See §6.4.

### Out-of-repo flag for the user

The user's global `~/.claude/CLAUDE.md` documents the 13-tool session surface verbatim and references a `LIBRARIAN_SESSION_ID` env var that isn't actually set anywhere in the current code. After cutover, the user should rewrite that section to describe the four-verb surface and drop the env var reference. This file is outside any repo; the spec can't touch it.

---

## 5. Code style

Existing conventions (no change). Key reminders:

- TypeScript strict mode; no `any` without comment.
- Zod schemas in `packages/core/src/schemas/` are the source of truth for input/output shapes; types are inferred via `z.infer<typeof Schema>`.
- MCP tools follow the pattern in existing `packages/mcp-server/src/mcp/tools/*.ts`:
  ```ts
  export const storeHandoff: McpTool = {
    name: "store_handoff",
    description: "...",
    inputSchema: StoreHandoffInput,
    handler: async (input, ctx) => {
      const validated = StoreHandoffInput.parse(input);
      const result = await ctx.handoffStore.store(validated);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  };
  ```
- Store layer is pure — no MCP awareness; receives parsed input, returns typed result.
- Tests colocated (`foo.ts` next to `foo.test.ts`) for core; integration tests under `packages/<pkg>/tests/`.
- No comments narrating *what* the code does; only *why* if non-obvious.
- Slash command markdown files follow the existing `.claude/commands/lib-session-start.md` pattern: frontmatter with `description`, body with instructions to the agent.

---

## 6. The contract

### 6.1 MCP tool surface

#### `store_handoff`

**Purpose:** Agent calls this at the end of `/handoff` to persist the document.

```ts
StoreHandoffInput = {
  title: string;              // 5..120 chars; meaningful summary
  document_md: string;        // 100..50000 chars; conforms to §6.3 template
  project_key?: string | null;
  source_ref?: string | null;
  cwd?: string | null;
  harness?: string | null;
  tags?: string[];            // 0..10 short strings
};

StoreHandoffOutput = {
  handoff_id: string;         // 'hdo_*'
  created_at: string;         // ISO 8601
};
```

Validation lives in the Zod schema (MCP boundary), **not** in the store. The schema includes a refinement that asserts five anchored headings via `^## (Start & intent|Journey|Current state|What's left|Open questions)\b` (multiline). Store layer trusts validated input. `domain` is resolved server-side from the authenticated caller (existing `packages/mcp-server/src/mcp/domain-resolution.ts`); not part of the input shape.

#### `list_handoffs`

**Purpose:** Called by `/takeover` to populate the picker.

```ts
ListHandoffsInput = {
  project_key?: string | null;
  cwd?: string | null;
  harness?: string | null;
  limit?: number;             // default 20, max 100
};

ListHandoffsOutput = {
  handoffs: Array<{
    handoff_id: string;
    title: string;
    project_key: string | null;
    source_ref: string | null;
    cwd: string | null;
    created_in_harness: string | null;
    created_by_agent_id: string | null;
    created_at: string;       // ISO 8601 — clients format age locally
    tags: string[];
  }>;
};
```

**Filter semantics (resolving D9 ↔ §6.1 misalignment from v1.0):**

- Server always scopes by the caller's resolved `domain` (multi-tenant isolation, identical to memory tools — non-overridable). This is enforcement, not user-facing filtering.
- Default user-facing filter (per **D9**): `claimed_at IS NULL` AND `project_key = ?` AND `cwd = ?` when both are supplied by the caller; if either is null, falls back to no filter on that axis. The agent invoking `/takeover` will normally supply both from its environment.
- Ranked by `created_at DESC`. No `age_seconds` field — client computes from `created_at`.

#### `claim_handoff`

**Purpose:** Called by `/takeover` when the user picks one. Atomic claim + read in a single transaction.

```ts
ClaimHandoffInput = {
  handoff_id: string;
  claiming_agent_id?: string | null;
  claiming_harness?: string | null;
  claiming_source_ref?: string | null;
  claiming_cwd?: string | null;
};

ClaimHandoffOutput = {
  handoff_id: string;
  title: string;
  document_md: string;
  created_by_agent_id: string | null;
  created_in_harness: string | null;
  created_at: string;
  claimed_at: string;
};
```

Error cases:
- Handoff not found → 404-style error.
- Handoff already claimed → 409-style error with `claimed_at` and (if recorded) `claimed_by_agent_id` in the error payload so the caller can render "claimed by X at Y."

### 6.2 Storage schema

Schema collapsed from v1.0's 14 columns to 10. The four claimed-metadata columns (`claimed_in_harness`, `claimed_source_ref`, `claimed_cwd`, `claimed_by_agent_id`) collapse into one `claimed_by_json` blob, mirroring `tags_json`.

```sql
CREATE TABLE handoffs (
  id                      TEXT PRIMARY KEY,             -- 'hdo_<ulid>'
  title                   TEXT NOT NULL,
  document_md             TEXT NOT NULL,
  project_key             TEXT,
  source_ref              TEXT,
  cwd                     TEXT,
  domain                  TEXT NOT NULL,
  created_by_agent_id     TEXT,
  created_in_harness      TEXT,
  tags_json               TEXT NOT NULL DEFAULT '[]',   -- JSON array
  created_at              TEXT NOT NULL,                -- ISO 8601
  claimed_at              TEXT,                          -- NULL = unclaimed
  claimed_by_json         TEXT                          -- JSON: {agent_id, harness, source_ref, cwd} or NULL
);

CREATE INDEX idx_handoffs_unclaimed
  ON handoffs(domain, project_key, cwd, created_at)
  WHERE claimed_at IS NULL;
```

One index — the partial unclaimed-by-project-cwd composite. The previously specified second index over `created_at` was YAGNI at expected volumes.

**Atomic claim** runs inside `BEGIN IMMEDIATE` to take the write lock up front and avoid the read-then-update race under multi-writer WAL:

```sql
BEGIN IMMEDIATE;
UPDATE handoffs
   SET claimed_at = ?,
       claimed_by_json = ?
 WHERE id = ?
   AND claimed_at IS NULL
RETURNING *;
-- If empty (no row returned), the same transaction issues:
SELECT id, claimed_at, claimed_by_json
  FROM handoffs
 WHERE id = ?;
-- Then COMMIT and return 404 (row absent) or 409 (row present with claimed_at NOT NULL).
COMMIT;
```

The follow-up SELECT inside the same transaction guarantees the 409 payload reflects a consistent snapshot of the existing claim.

### 6.3 Handoff document template

Exact format the agent must produce:

```markdown
# Handoff: <title>

## Start & intent
<what the user came in wanting; why; constraints>

## Journey
<compressed timeline:
- decisions made (and why)
- alternatives considered and rejected
- deferred work / parking lot
- dead ends / lessons learned>

## Current state
<where we are right now — detailed: files touched, branches,
open PRs, what works, what doesn't, known gotchas>

## What's left
<concrete next steps, in order, with enough context to start cold>

## Open questions
<things needing human decision before next step>
```

The agent's slash command prompt (§6.5) instructs the LLM to fill each section faithfully. Headings are part of the contract — validated by `store_handoff`.

### 6.4 Schema migration

This is a **breaking** schema change, no migration code. The migration piggybacks on the existing `PROJECTION_SCHEMA_VERSION` bump path in `packages/core/src/store/projection.ts` (note: the constant is `PROJECTION_SCHEMA_VERSION`, not `SCHEMA_VERSION` as v1.0 incorrectly stated). The existing `initSchema` rebuild path already runs inside `BEGIN`/`ROLLBACK` (projection.ts:722 today) — reuse it.

Inside the existing transaction:

1. Bump `PROJECTION_SCHEMA_VERSION`.
2. `DROP TABLE IF EXISTS sessions`.
3. `DROP TABLE IF EXISTS session_events`.
4. `DROP TABLE IF EXISTS session_state_changes`.
5. `DROP TABLE IF EXISTS session_events_fts` (and the FTS5 shadow tables: `session_events_fts_data`, `session_events_fts_idx`, `session_events_fts_docsize`, `session_events_fts_config` — `DROP TABLE IF EXISTS` each one explicitly).
6. `CREATE TABLE handoffs` per §6.2.
7. Stamp new schema version.

If any step fails, the transaction rolls back and the boot aborts with a clear error. No half-migrated state possible.

**Operator-side artefacts on disk:**

After the table drops, `session_events.jsonl` and `sessions.legacy.jsonl` may still exist in the data directory (they were the JSONL ledger). On boot:

- If either file exists, rename to `<name>.predeprecation.bak` and log a one-line warning so operators know they're harmless leftovers.
- The renamed `.bak` files are never read by the new code; operators can archive or delete at their convenience.

**Backup format:**

`packages/core/src/backup/backup.ts` currently archives `session_events.jsonl` and `sessions.legacy.jsonl`. Post-cutover backups will not include these files. `restore.ts` must tolerate their absence (it already hedges in code comments). Document in `CHANGELOG.md` that v.N+1 backups are not restore-compatible with v.N stores that need session data — operators on old backups must restore on v.N first and then upgrade.

**Curator drain at deploy:**

The curator worker may be mid-tick when PR 1 deploys. It hashes session ids into its input fingerprint and writes session-referencing rows. Procedure for the operator deploying PR 1:

1. Stop the curator worker (existing process control — typically `pnpm --filter @librarian/mcp-server stop` or signal-based).
2. Deploy PR 1 (schema migration runs on first boot).
3. Restart the curator worker; it now reads the rewritten curator-evidence (§12) and runs without session state.

Document this drain step in the PR 1 release notes.

### 6.5 Slash command contracts

The contract here specifies **what each verb must and must not do** — not the exact wording. Each harness picks phrasing that fits its native format (Claude markdown, OpenCode plugin spec, Codex .mjs, Hermes Python, Pi TS).

#### `/handoff`

The agent must:
1. Check whether the latest `[librarian:private=on|off]` marker in the conversation indicates `on`. If so, ask the user for explicit consent before proceeding (per D12) and abort on no.
2. Read the full conversation transcript via the harness's native API; if unavailable, fall back to the in-context view (per D1).
3. Author a five-section document conforming to §6.3, including a meaningful title (≤80 chars).
4. Resolve `project_key` and `cwd` from the environment and call `store_handoff` with the document.
5. Report success to the user with the `handoff_id` and how to pick it up.

#### `/takeover`

The agent must:
1. Call `list_handoffs` with the current `project_key` + `cwd`. If empty, broaden by progressively dropping filters.
2. Present the candidates with title, source harness, age (computed from `created_at`), and tags.
3. On selection, call `claim_handoff`. On 200, inject the returned `document_md` into the conversation as system context. On 409, surface the conflict and offer to re-list.

#### `/learn`

The agent must:
1. Run the same private-mode consent check as `/handoff` (D12).
2. Read the transcript (transcript-first, in-context fallback — same as `/handoff`).
3. Extract candidate lessons. Prefer durable facts ("user is X", "project uses Y"), validated patterns ("we found Z works because…"), and explicit user corrections. Reject ephemeral state (in-progress task, transient debugging context).
4. Present as a multi-select list and, for each chosen lesson, call `propose_memory`. Protected categories route through the existing proposal flow unchanged.

#### `/toggle-private`

The agent must:
1. Scan the conversation for the most recent `[librarian:private=on|off]` marker.
2. Inject a system message with the inverse state. The marker must include both a machine token (`[librarian:private=on]` or `[librarian:private=off]`) and a human-readable instruction. Suggested wording (not mandatory):
   - ON: *"Private mode is ON. Do not call `remember` or `propose_memory` until told otherwise. Recall is still allowed. `/handoff` and `/learn` will require explicit confirmation."*
   - OFF: *"Private mode is OFF. Normal operation resumed."*
3. Confirm to the user.

**No persisted state, no plugin hook, no Librarian-side flag.** Default when no marker is present: OFF.

**Known limitation — conversation compaction can erase the private marker.** If the harness compacts and drops the `[librarian:private=on]` system message, the agent falls back to the default (OFF) and resumes writing durable memory. This is a real privacy regression vs. the pre-cutover state-file approach. The spec accepts this trade for the simplification benefit (no hook, no state, uniform across all harnesses including Pi/Hermes). Two mitigations the agent should implement:
- **Re-inject on context restore.** If a harness exposes a "context restored after compaction" signal, the slash command implementation should re-scan and re-inject the marker if it was on.
- **Prompt-side reminder.** The system message wording in step 2 should include "remain in this state until explicitly toggled off" — this gives the LLM a chance to re-emit the marker on its own if it notices the gap.

Operators should be aware: prolonged sessions with aggressive compaction may silently exit private mode. If hard guarantees are needed, an operator can run the session with `--no-compact` or equivalent.

### 6.6 CLI (`packages/cli`)

New subcommands replace removed `sessions` subcommands. CLI verbs are top-level files in `packages/cli/src/commands/` (matching existing convention — no `commands/handoffs/` subdir).

```
the-librarian handoffs list [--project KEY] [--cwd PATH] [--limit N] [--include-claimed]
the-librarian handoffs show <handoff_id>
the-librarian handoffs purge <handoff_id>      # admin; single-target only
```

`show` displays the document; `purge` hard-deletes the row (admin tokens only). Batch purge (`--older-than`, `--claimed-only`) is YAGNI for v1 and can be added in a follow-up when an operator actually needs it.

### 6.7 Dashboard

New routes under `apps/dashboard/app/handoffs/`:

- `/handoffs` — list view, default filters: unclaimed only, current project. Toggle to show claimed. Each row links to detail.
- `/handoffs/[id]` — detail view: rendered markdown of `document_md`, metadata sidebar (created_by, created_in_harness, claim status, age, tags), claim-history block when claimed.

Read-only — no claim button (claim is an agent operation via MCP).

Existing sessions surface is removed in the same PR — full file list in §4 under "Dashboard." This includes:
- `app/sessions/` routes (page, detail page, server actions)
- `components/sessions/` directory (seven component files)
- `e2e/sessions.spec.ts` and its component test counterparts
- Nav entry in `components/site-nav.tsx` → flip to `/handoffs`
- `components/keyboard-host.tsx` — `nav-sessions` target, `trpc.sessions.list` query, `"s"` keybinding → repoint to handoffs
- `components/ui-v2/command-palette.tsx` placeholder text
- `app/layout.tsx` page description

Test files for the new pages live at `apps/dashboard/tests/components/handoffs.test.tsx` (matching existing convention — not colocated with the route).

---

## 7. Testing strategy

### Unit tests (Vitest, monorepo)

- `packages/core/src/store/handoff-store.test.ts` — CRUD, atomic claim under simulated contention (two parallel `claim` calls), filter-by-domain/project/cwd, listing ordering.
- `packages/core/src/schemas/handoff.test.ts` — Zod validation: required headings present/absent (anchored regex), length bounds, tag count bounds.
- **Curator decoupling tests** (see §12): existing curator tests updated to remove session-evidence fixtures; new tests cover the time-based run gate and memory-only evidence path.

### Integration tests (MCP)

- `packages/mcp-server/tests/mcp/handoffs.mcp.test.ts` — round-trip each tool via the MCP transport.
  - `store_handoff` → `list_handoffs` (sees it) → `claim_handoff` (returns doc, marks claimed) → `list_handoffs` (no longer sees it) → `claim_handoff` (409).
- Domain isolation: a handoff stored in domain A is not listed for a caller in domain B.
- Project/cwd filtering: stored with project=acme cwd=/a, list filtered by project=acme cwd=/b returns empty.

### Scenario coverage (per §9 of brainstorm)

| Scenario | Test type | Notes |
|---|---|---|
| A — pre-planned handoff | integration | happy-path |
| B — surprise handoff | integration | same impl as A |
| C — agent dies mid-work | manual | documented in README, no code path |
| D — cross-harness pickup | smoke (end-to-end) | requires both Claude and OpenCode plugin smoke harness |
| E — same-harness new window | integration | exactly D minus harness diff |
| F — multiple handoffs | integration | populate 3 handoffs, verify list order + age |
| G — `/learn` after non-handoff | integration | mock conversation, assert propose_memory calls |
| H — toggle-private during work | unit (slash command) | assert system-message injection |
| I — private then handoff | integration | assert confirmation prompt path |
| J — stale handoff | integration | age computation; no expiry logic |
| K — concurrent claim | unit (handoff-store) | parallel claims; one 409 |
| L — no-transcript fallback | manual | documented limitation |
| M — `/learn` while private | integration | confirmation prompt path |
| N — failed store | unit | mock store throws; agent reports failure |

### Coverage gates

The repo doesn't enforce per-file coverage anywhere else; introducing one for the new files is ceremony. The actual gate is the scenario-coverage table above plus the existing test-count baseline.

- `scripts/check-test-count.mjs` baseline (`test/baseline.json`) updated after PR 1. Net change: roughly `-session_tests + new_handoff_tests + curator_tests_updated`.
- All new code paths exercised by at least one integration test per the scenario table.

### Smoke tests

- Monorepo `pnpm smoke`: extended to include a `store_handoff` → `list_handoffs` → `claim_handoff` round-trip against a local instance.
- Claude plugin `npm run smoke`: invoke `/handoff` via simulated harness, assert call to `store_handoff`.
- OpenCode plugin `bun run smoke`: same.

---

## 8. Boundaries

### Always do

- Run `pnpm typecheck && pnpm lint && pnpm test` before each commit.
- Use Zod schemas as the input boundary; never trust raw input to MCP tools.
- Write integration tests that exercise the actual SQLite store, not mocks.
- Update the `CHANGELOG.md` in each repo for every breaking change.
- When deleting a tool, also delete its tests and any docs referencing it.
- Bump `PROJECTION_SCHEMA_VERSION` when changing the schema in any way.
- Wrap atomic operations in `BEGIN IMMEDIATE` to take the write lock up front under multi-writer SQLite WAL.

### Ask first

- Adding any new MCP tool beyond the three in §6.1.
- Adding any plugin hook beyond what already exists post-cleanup (the goal is zero session-related hook code).
- Changing the handoff template shape (§6.3) — the agent's contract depends on it.
- Backwards-compatibility shims for the old session API — they were considered and rejected (D10).
- Adding a Librarian-side LLM call (D4/D5 explicitly rejected this; revisiting requires reopening the brainstorm).
- Persisting private state to a file or to the server (D11 explicitly rejected this).

### Never do

- Reintroduce auto-capture of session events.
- Add a `sessions`, `session_events`, `session_state_changes`, or `session_events_fts` table back.
- Reintroduce `source_session_ids`, `input_session_ids`, or any session reference into the curator pipeline or its stored ops (see §12).
- Use natural-language private markers (`/private`, `/public`, "off the record") — D2 settled this.
- Block recall while in private mode — D3 explicitly allows reads.
- Skip the confirmation prompt for `/handoff` or `/learn` while private — D12.
- Persist private-mode state to disk or to the server — D11 settled this; in-conversation only.
- Force-push to main or skip the PR review process (per Jim's global CLAUDE.md).
- Commit changes that touch more than one of the five PR boundaries (§9).

---

## 9. PR plan

> **v1.1 revision:** During plan-phase prep we elected 8 additive-then-destructive PRs over the 5-PR plan below, for autonomous-build safety. The detailed task breakdown is in **`sessions-rethink-plan.md`**. This section is retained as the higher-level scope description; refer to the plan doc for the actual implementation sequence.

The 8-PR sequence at a glance:
- PR 0: Curator decouples from sessions (monorepo). Sessions still exist; curator stops reading them.
- PR 1: Add handoffs surface (monorepo, additive). New code side-by-side with old.
- PR 2–6: One PR per plugin (Claude, Codex, OpenCode, Hermes, Pi). Each removes old session usage and adds new commands.
- PR 7: Monorepo cleanup. Remove the 13 MCP tools, drop session tables, delete dashboard/CLI/tRPC sessions surface.

The original 5-PR plan (preserved for context):

### PR 1 — Monorepo: new surface + drop old + curator decoupling

**Branch:** `feat/sessions-rethink-monorepo`
**Scope:** `the-librarian` only.
**Includes:**
- Add `handoffs` schema, store, three MCP tools, CLI subcommands, dashboard pages.
- Delete all session schema, store, MCP tools, tRPC routes, CLI subcommands, dashboard pages/components/e2e, tests, scripts, and `.claude/commands/lib-session-*` (full list in §4).
- Decouple curator from sessions per §12 (modifies curator-worker, curator-prompt, curator-output, curator-validate, curator-apply, curator-schedule, curator-scheduler, curator-redaction, curation-store; deletes curator-evidence.ts).
- Rewrite `projection.ts` for memory-only; piggyback schema migration on existing `PROJECTION_SCHEMA_VERSION` transaction (§6.4).
- Drop `session_events.jsonl` / `sessions.legacy.jsonl` from backup pipeline; rename on-disk leftovers to `.predeprecation.bak` at boot.
- Update `docs/slash-commands.md`, root README, CHANGELOG, `scripts/healthcheck.js` allow-list, `test/baseline.json` test count.

**Verify:** all monorepo gates pass; smoke test round-trip works; curator integration tests green; `rg -i "session" packages/ apps/ scripts/ docs/ -g '!*.bak'` returns zero hits in non-test code (or only documented intentional refs).

**Critical risks:**
1. Breaks every plugin until they ship matching updates. Acceptable per D10; document in PR description.
2. Operators with in-flight curator runs may see one tick fail mid-deploy. Mitigated by drain step in §6.4.
3. Backup-format change: post-cutover backups cannot restore into pre-cutover stores. Documented in CHANGELOG.

This PR is the largest of the five — likely a long-running review. Consider splitting the curator decoupling into a prep PR (`feat/sessions-rethink-curator-decouple`) that lands first if the diff gets unwieldy; the curator can be made memory-only *before* sessions are removed, since the curator's session usage is read-only.

### PR 2 — Claude plugin

**Branch:** `feat/sessions-rethink-claude` in `the-librarian-claude-plugin`.
- Delete session hook code (`claude-code-hook.ts`, `session.ts`, `harness/claude-code.ts` lifecycle wiring, most of `state.ts`).
- Delete `commands/lib-session-*.md` and `commands/lib-toggle-private.md`.
- Add `commands/handoff.md`, `takeover.md`, `learn.md`, `toggle-private.md`.
- Update README, AGENTS.md, CHANGELOG.

**Verify:** typecheck, validate, smoke. Manual: install plugin, invoke each command, observe correct MCP tool call.

### PR 3 — Codex plugin

**Branch:** `feat/sessions-rethink-codex` in `the-librarian-codex-plugin`.
- Delete `src/handlers/{post-compact,checkpoint-policy,user-prompt-submit}.mjs` (or strip session bits if they handle other concerns).
- Collapse `src/dispatch.mjs` to bootstrap-only.
- Remove session entries from `hooks/`.
- Add the four command files.

**Verify:** smoke + manual.

### PR 4 — OpenCode plugin

**Branch:** `feat/sessions-rethink-opencode` in `the-librarian-opencode-plugin`.
- Delete `src/handlers/{chat-message,session-idle,session-compacted,checkpoint-policy}.ts`.
- Collapse `src/index.ts` event handler to bootstrap.
- Add the four command files in `commands/`.

**Verify:** `bun test` and smoke.

### PR 5 — Hermes + Pi cleanup

**Branch:** `feat/sessions-rethink-fringe` (one PR per repo if cleaner).
- **Hermes:** delete session commands from `commands.py` and session-tool methods from `client.py`. Add the four commands.
- **Pi:** delete `extensions/librarian/session-client.ts`. Update `commands.ts` to expose the four verbs if Pi has a command surface. Drop session imports from `index.ts` and `orchestrator.ts`.

**Verify:** repo-native checks.

### Ordering constraints

PR 1 must merge first. PRs 2–5 can land in any order after PR 1 but the deployer must update the MCP server before users of any plugin will see the new commands work.

---

## 10. Open questions for plan phase

Resolved during plan-phase prep (2026-05-28):

1. ~~**ID generation for `hdo_*`**~~ — Use existing `makeId("hdo")` from `packages/core/src/constants.ts` (same pattern as `mem`, `ses`, `evt`).
2. ~~**Curator `safe` vs `normal` apply policy**~~ — Resolved per §12.3: only the session-derived `safe` path is removed; exact-duplicate `safe` survives.
3. ~~**Curator run cadence**~~ — Resolved per §12.4: disabled by default; operator opts in.

Remaining (deferred to per-PR plan):

4. **Dashboard auth posture** — Confirm during PR 1 against existing dashboard conventions.
5. **Pi command surface** — Confirm during PR 6 by reading `extensions/librarian/commands.ts` and Pi's command-registration spec.
6. **Slash-command native conventions** — Confirm per-plugin during PR 2–6 by following existing command file patterns.
7. **`source_ref` semantics for handoffs** — Same convention as today (`claude:session:{CLAUDE_SESSION_ID}` preferred, `cwd:{path}` fallback). No change needed.
8. **Compaction-restore signal availability** — Check each plugin's hook surface during PR 2–6. If a plugin can detect compaction-restore, wire the marker re-injection; otherwise accept the limitation per §6.5.

---

## 11. Success conditions checklist

Pre-merge for PR 1:
- [ ] Three new MCP tools registered and round-trip in tests.
- [ ] Zero references to the 13 dropped session tools in source (verify with `rg`).
- [ ] `handoffs` table created; `sessions`, `session_events`, `session_state_changes`, `session_events_fts` (and FTS5 shadow tables) dropped via the transactional migration path.
- [ ] Curator pipeline has zero session references — `rg "session" packages/core/src/curator-*.ts packages/core/src/store/curation-store.ts` returns nothing.
- [ ] tRPC `appRouter` has no `sessions` key; dashboard compiles without it.
- [ ] Dashboard `/sessions` removed; `/handoffs` and `/handoffs/[id]` render; nav + keybindings + command-palette repointed.
- [ ] CLI `handoffs list|show|purge` works; `sessions` subcommand gone from `runtime.ts`.
- [ ] `scripts/healthcheck.js` allow-list no longer references session tools.
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm smoke` green.
- [ ] CHANGELOG entry describes: schema break, backup-format change, curator decoupling, drain step.

Pre-merge for each plugin PR:
- [ ] No `record_session_event`, `start_session`, etc. calls remain in plugin source.
- [ ] No natural-language privacy detection code remains (`privacy-detector.ts`, `privacy_gate.py`, `privacy.py`, `privacy.ts`).
- [ ] Four new commands present; old `lib-session-*` commands absent.
- [ ] Plugin-native validate + smoke pass.
- [ ] Manual: invoke each command end-to-end against a local Librarian instance.
- [ ] CHANGELOG entry describes the breaking change.

End of project:
- [ ] All six repos pass their checks.
- [ ] One end-to-end demo: `/handoff` in Claude → `/takeover` in OpenCode → document arrives in second agent. Documented in a brief release note.
- [ ] `sessions-rethink.md` and `sessions-rethink-spec.md` linked from the relevant CHANGELOG entries.
- [ ] User has updated their `~/.claude/CLAUDE.md` to drop the 13-tool session surface description and the `LIBRARIAN_SESSION_ID` env var note.

---

## 12. Curator decoupling

> Added in v1.1 after independent review. The curator's evidence model is currently "memories + sessions" — session evidence is read by `curator-evidence.ts`, fed into the LLM prompt via `curator-prompt.ts`, hashed into the input fingerprint, persisted as `source_session_ids` on every curator op, and gated by `min_sessions_since_run`. With sessions gone (per D7), the entire session-evidence path collapses. Per Jim's confirmation: **the curator should not look at sessions.** This section specifies how.

### 12.1 The change in one sentence

The curator becomes **memory-only**: its evidence is the existing memory store, its run cadence is time-based, and its op schema drops every session-referencing field. The `/learn` slash command (D5) replaces the implicit "extract lessons from sessions" job that session evidence was doing.

### 12.2 File-by-file modifications

| File | Change |
|---|---|
| `packages/core/src/curator-evidence.ts` | **Delete.** Functions `gatherSessionEvidence`, `selectSessions`, `selectSessionEvents`, types `SessionEvidenceBundle`, `SessionRow`, `SessionEventRow`, constant `DEFAULT_MAX_EVENTS_PER_SESSION` are all session-only. |
| `packages/core/src/curator-worker.ts` | Remove all `input_session_ids` references (lines 68, 80, 96, 108, 133, 164, 178). The input fingerprint hashes only memory state and run timestamp. The evidence bundle passed to the LLM contains only `memories`. |
| `packages/core/src/curator-prompt.ts` | Rewrite the system prompt (lines 24, 37, 44, 48, 71, 77, 82). Drop "create memories for durable facts evidenced by sessions"; reframe as "review and consolidate existing memories." Remove `source_session_ids` from the schema description shown to the LLM. |
| `packages/core/src/curator-output.ts` | Remove `source_session_ids` from Zod schemas for `create` and `archive` ops (lines 66, 93). |
| `packages/core/src/curator-validate.ts` | Drop the `sessionIds` referential-integrity check (lines 36, 62, 101, 126, 188, 189, 333). See §12.3 for what replaces the `safe`/`normal` policy discriminator. |
| `packages/core/src/curator-apply.ts` | Drop `source_session_ids` from applied ops (lines 265, 281, 290, 309, 310). |
| `packages/core/src/curator-schedule.ts` + `packages/core/src/curator-scheduler.ts` | Replace `min_sessions_since_run` gate with `min_minutes_since_run`. Remove `newSessionCount`, `sessionFilter` over the `sessions` table. See §12.4. |
| `packages/core/src/curator-redaction.ts` | If the only redaction logic was for session summaries, delete the file; otherwise strip the session-summary path. |
| `packages/core/src/store/curation-store.ts` | Drop `input_session_ids`, `source_session_ids` columns from the `curation_runs` and `curation_ops` tables (lines 25, 40, 61, 74, 125, 145, 178, 189, 203, 217, 273, 284). Schema migration is part of the same `PROJECTION_SCHEMA_VERSION` bump as the session table drops (§6.4). |

### 12.3 The `safe` vs `normal` apply policy

**(v1.1 correction.)** v1.0 of this section over-stated the change. Reading `packages/core/src/curator-validate.ts`:

- Line 333 is the session-evidence path: `op.source_session_ids.length > 0 ? "safe" : "normal"`. **This line goes.**
- Lines 327–330 derive `safe` from exact-duplicate detection (`source_memory_ids.every((id) => exactDupIds.has(id))`). **These stay.**

So the `safe` risk level and the `safe_only` admin policy in `curator-apply-policy.ts` survive intact. Only the session-derived shortcut to `safe` is removed. After this change, ops are still classified as `safe` when they re-state existing memories exactly; everything else falls through to `normal`/`risky`/`protected` per the existing rules.

The `RiskLevel` union (`"safe" | "normal" | "risky" | "protected"`) is unchanged.

### 12.4 Run cadence — disabled by default; explicit operator opt-in

Today the curator runs when *N* new sessions exist since the last run. With sessions gone, that gate has no semantics. Rather than swap in a time-based default and have the curator start ticking on its own, **the curator is disabled by default in v1.1**. Operators who want consolidation must explicitly enable it via config (new key: `curator.enabled = true` or equivalent — match existing config naming convention).

When enabled, the curator runs on a simple time interval (default: `curator.interval_minutes = 60`). No event-driven triggers.

Rationale:
- Sessions are gone; there is no longer a natural "this triggered a run" signal.
- Defaulting off avoids surprising operators with auto-runs they didn't ask for, and keeps the v1 cutover behaviour conservative.
- Time-based interval (when enabled) is simpler than write-volume gating; the curator's job is consolidation over time, not reaction to write volume.

Configuration migration: existing `min_sessions_since_run` values are ignored on first boot post-cutover; the curator is OFF until an operator flips the new flag. Boot logs a one-line notice describing the change.

### 12.5 The job that session evidence *was* doing

Worth naming explicitly: today, session evidence is how the curator notices "things the user did during a recent session that should be promoted to memory." That responsibility has moved out of the curator entirely:

- The user invokes `/learn` (D5) at moments of their choosing.
- The active agent extracts candidate lessons from the transcript.
- The user multi-selects.
- Each chosen lesson goes through `propose_memory` — the existing proposal flow the curator already understands as memory evidence.

So nothing is lost — the same lessons still flow into durable memory. The trigger moves from "the curator runs and notices" to "the user runs `/learn` and decides."

### 12.6 Tests to update

- `packages/core/tests/curator-evidence.test.ts` — delete (currently in the working-tree change list per `git status` at brainstorm time).
- Curator integration tests fixturing session rows — strip session fixtures, fixture only memory rows.
- New test: time-based gate honours `min_minutes_since_run` config.
- New test: curator op without `source_session_ids` passes the apply pipeline.

### 12.7 Why this might warrant a prep PR

The curator's session usage is **read-only** — it reads sessions and writes only to curator-side tables. That means the curator can be made memory-only *before* the session tables are dropped. If PR 1's diff gets unwieldy, a prep PR (`feat/curator-decouple-from-sessions`) that lands first would:

- Remove all session reads from the curator (curator-evidence delete, prompt rewrite, schema fields removed).
- Leave the session tables and tools intact for now.
- Bump the curation-store schema separately from the projection schema.

PR 1 (now smaller) then only handles session deletion + the new handoff surface. Together the two PRs accomplish the same net change but each is reviewable in isolation.

Decision deferred to the plan phase based on actual diff size.
