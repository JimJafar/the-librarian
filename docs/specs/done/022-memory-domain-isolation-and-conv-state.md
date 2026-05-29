# Spec: Memory Domain Isolation & Conversation State

**Author:** Claude, with Jim
**Date:** 2026-05-27
**Status:** Draft v4 — async classifier with configurable provider (revised from sync local-only); PR 6 + PR 7 collapsed into one; in line with [`023-classifier-implementation-spec.md`](./023-classifier-implementation-spec.md); implementation in flight (PRs 1–5 merged)

---

## 1. Purpose

Replace the current memory-isolation model with one that actually does what it claims. Today, of eight nominal isolation axes (`agent_id`, `project_key`, `visibility`, `scope`, `category`, `environment`, `harness`, `actor_kind`), only three function as isolation — and only two of those well. The remainder are either advisory labels, session-only concepts, or schema fields the read/write paths never use.

This spec introduces a simpler, owner-controlled model. The guiding principle: **agents should not be responsible for deciding policy.** The owner decides what is partitioned (via domains) and how memories are classified (via dashboard overrides on top of an automated classifier). Agents just write content; the server places it correctly.

1. A new memory field — **`domain`** — owner-defined via dashboard, assigned per *conversation*, hard-filtered on recall.
2. A new memory field — **`is_global`** — boolean. When true, the memory bypasses domain filtering. Set by a write-path classifier; overridable by the owner.
3. A new memory field — **`requires_approval`** — boolean. When true, the memory enters the proposal queue instead of going active. Set by the same write-path classifier; overridable by the owner.
4. A new server-side **conversation-state registry** that survives context compaction and centralises per-conversation state (current `domain`, attached `session_id`, `off_record` flag, future flags).
5. A **harness hook contract** that re-injects conversation state into the prompt on every turn, defeating compaction-driven state loss.
6. A **signal-precedence chain** for choosing the domain at conversation start, owner-configured via the dashboard.
7. A **write-path memory classifier** (small local LLM) that examines each new memory and decides `is_global` and `requires_approval`. Sync, with a conservative fallback on failure.
8. **Removal of `visibility`** — the `common | agent_private` distinction is redundant once domains exist. Privacy is owner-controlled via domain assignment, not agent-self-declared.
9. **Removal of `category`** — the enum conflated semantic labels (`tools`, `lessons`, `people`, ...) with policy signals (`identity`/`relationship` → protected, those plus `preferences` → global). Policy is now expressed directly via the two booleans; semantic labels move to the existing `tags[]` field.
10. **Removal of `scope`** — the enum was advisory metadata with no read-path consumer. `domain` subsumes its intended purpose.

The design is **opt-in to complexity**: a default install ships with a single domain (`general`) and prompts no one. Multi-domain partitioning activates only when the owner adds a second domain.

---

## 2. Non-goals

- **Not redesigning sessions.** Session lifecycle, resume semantics, and the session/memory boundary are unchanged. Sessions gain one new field (`domain`) but otherwise behave identically. See §4.12 for the resume-seeding rule.
- **Not touching `agent_id` or `project_key`.** Both remain. `agent_id` continues to be derived from authenticated context (per the [Agent Naming Contract](done/011-agent-naming-contract-spec.md)). `project_key` becomes a tag, not an isolation axis — agents may still set it for grouping, but it does not gate recall.
- **Not introducing per-domain RBAC or capability gates.** Domains scope memory visibility; they do not gate tool access or imply roles. An agent in `domain=coding` has the same MCP capabilities as one in `domain=family-admin`.
- **Not addressing multi-tenant / multi-user use.** The Librarian remains single-owner. Domains are an organisational tool for the owner, not a multi-user partition.
- **Not building a domain-hierarchy UI.** The dashboard surface is a flat list of strings. Hierarchies, colours, and per-domain settings are deferred until usage proves the need.

---

## 3. Background

See the brainstorm working doc at `~/Documents/obsidian-md/Notes/Work/The Librarian/memory-isolation.md` for the full evidence base. Compressed audit findings:

- **`environment` and `harness` are not memory fields.** They appear in spec docs but no column exists. Memories cannot be scoped or filtered by either.
- **`scope` is stored but never queried.** Not exposed in any tool input schema.
- **`project_key` is unenforced.** Any agent can write any value; recall does not default-scope by it.
- **`agent_id` is enforced on write but not on update.** A memory's owner can be patched by any caller holding the id.
- **`ToolContext` collapses identity to `"admin" | "agent"`.** Rich `actor_kind` (`agent | admin | system | cli`) exists in the data layer but is never piped to dispatch.
- **The current agent-self-declared-name pattern is brittle.** A renamed agent loses access to its prior memories. SOUL.md instructions are advisory; agents have demonstrated willingness to drift.

The user-facing problem this creates: the owner cannot reliably partition memories by role (coding vs research vs family admin), and even soft partitioning by agent name fails under agent-side drift.

---

## 4. The contract

### 4.1 Domain — a new memory field

A **domain** is a short string identifying the operational context in which a memory was created and to which it should be returned. The owner manages the list of valid domains via the dashboard.

- **Storage:** new column `domain TEXT NOT NULL DEFAULT 'general'` on `memories`.
- **Cardinality:** single-valued. A memory belongs to exactly one domain.
- **Source of truth:** the conversation-state registry at the moment of write. The agent does not supply `domain`; the server sets it from `conv_state.domain`.
- **Lifecycle:** assigned once at write time. Can be changed by the owner via the dashboard. Cannot be changed by agents.
- **Out-of-box default:** every install ships with a single domain, `general`. Existing memories are backfilled to `general` (see §7).

### 4.2 `is_global` — global-scope flag

A boolean column indicating that a memory should be returned regardless of session domain.

- **Storage:** new column `is_global INTEGER NOT NULL DEFAULT 0` on `memories` (SQLite boolean idiom).
- **Set by the write-path classifier** (see §4.4). Agents cannot supply this field on `remember`; the input schema does not advertise it. If supplied, it is ignored.
- **Overridable by the owner** via the dashboard (uses existing `updateMemoryAction`). An owner can flip `is_global` on any memory at any time.

### 4.3 `requires_approval` — proposal-routing flag

A boolean column indicating that a memory should enter the proposal queue rather than going active.

- **Storage:** new column `requires_approval INTEGER NOT NULL DEFAULT 0` on `memories`.
- **Set by the write-path classifier** (see §4.4). Agents cannot supply this field on `remember`; the input schema does not advertise it. If supplied, it is ignored.
- **Replaces `PROTECTED_CATEGORIES`.** The old logic — "if `category ∈ {identity, relationship}` then `status = proposed`" — becomes "if `requires_approval` then `status = proposed`". Same proposal workflow, keyed differently.
- **Overridable by the owner** via the dashboard. Setting `requires_approval = true` on an active memory routes it back to the proposal queue. Setting it to `false` on a proposed memory activates it (equivalent to approval).

### 4.4 The write-path classifier

A small LLM (local by default, configurable to a remote OpenAI-compatible endpoint) that classifies each new memory and decides `is_global` and `requires_approval`. **Implementation details, model choice, eval design, and lifecycle live in the [classifier implementation spec](./023-classifier-implementation-spec.md).** This section captures the binding contract; that document captures the rest.

- **Async, not sync.** `remember` writes the memory with conservative defaults and returns immediately; a background worker classifies and updates the booleans + status when the verdict lands. The agent's `remember` response is always "Memory saved" regardless of classification state.
- **Conservative defaults at write time:** `requires_approval = true`, `is_global = false`. The same values the sync design used as a fallback are now the *default* state until the classifier commits. Rationale: an unreviewed sensitive fact landing in active is a leak; a non-sensitive fact briefly sitting in the proposal queue is a recoverable nuisance.
- **30-second per-attempt timeout, 3 retries, then giveup.** A classifier that never produces a verdict (after 3 failed attempts) leaves the memory at conservative defaults and emits `memory.classified` with `fallback_used: "max_retries"` so the eval substrate sees it.
- **Configurable provider.** Admin picks local (default, in-process via node-llama-cpp) or remote (OpenAI-compatible HTTP API). Provider config is independent of the curator's. See classifier-spec §4.2.
- **Prompt:** versioned, stored alongside the classifier service. Strictly JSON-validated output.
- **Observability:** every classifier call appends a `memory.classified` event to `events.jsonl` carrying provider, model, prompt version, raw model output, parsed booleans, queue-wait + inference time, attempt number, and `fallback_used` (false / "timeout" / "parse" / "provider_unavailable" / "max_retries"). The eval substrate replays from this.
- **Owner override is the ground truth.** Once an owner overrides either boolean via the dashboard, the override is recorded as a `memory.classification_overridden` event and the classifier's original verdict is preserved alongside for evaluation purposes.
- **Evaluation is operator-driven from the dashboard, not CI-driven.** A synthetic fixture (~1000 memories, multi-model consensus-labelled) lives in the repo; the dashboard runs the classifier against a stratified sample on demand when promoting prompts or candidate models. CI tests the machinery (parser, retry, migration) with mocked classifiers — quality judgement is the operator's. See classifier-spec §4.6.

### 4.5 Removal of `category`

The `category` column and the `Category` enum are **dropped from the memory schema entirely**.

- **Rationale:** of the nine former category values, only `identity`, `relationship`, and `preferences` drove behaviour (protection routing and global-scope derivation). Both behaviours are now expressed directly via §4.2 and §4.3. The remaining categories (`projects`, `environment`, `tools`, `lessons`, `people`, `open_threads`) were semantic labels that never drove system behaviour. Conflating policy with labels in a single enum forced the agent to make policy decisions disguised as classification choices.
- **What replaces semantic labels:** the existing `tags[]` array on memories. Migration converts the former category value into a tag (e.g. `category=tools` → `tags: [..., 'tools']`).
- **Recall filtering:** the `categories: []` input on `recall` is removed and **replaced with `tags: []`** (new — the recall tool currently has no tag filter; this spec adds one). Semantic filtering on recall continues to work, just keyed differently.
- **Dashboard grouping:** the category-grouped views in the dashboard are reworked to group by `tags`, `domain`, and the two booleans. The dashboard gains explicit filters for "Global only" and "Pending approval" since these are now the load-bearing distinctions.
- **Removed surface:**
  - `category` column on `memories`
  - `Category` enum and `PROTECTED_CATEGORIES` constant
  - `categories: []` input on `recall`
  - All `category` references in `normalizeMemoryInput`, dashboard category filters, and integration docs.

### 4.6 Removal of `visibility`

The `visibility` column (`common | agent_private`) is **dropped from the memory schema entirely**.

- **Rationale:** agent-private visibility existed because there was no other way to keep one agent's memories out of another agent's recall. Domains now solve that, and they do so under owner control rather than agent self-declaration.
- **What replaces agent-private memories:** the owner creates a domain (e.g. `personal-notes`, `agent-X-scratch`) and routes those memories there via signal rules or manual session-start picks.
- **Removed surface:**
  - `visibility` column on `memories`
  - `Visibility` enum
  - `include_private` input on `recall`
  - All `visibility`-related logic in `searchMemories`, `listMemories`, `visibleResourceMemories`, `scopeAgentArgs`
- **Admin role retains its bypass.** Role-based access (admin sees all, agents see only their domain + globals) replaces visibility-based access. Admin status is a property of the caller, not a per-memory flag.

### 4.7 Removal of `scope`

The `scope` column and the `Scope` enum are **dropped from the memory schema entirely**.

- **Rationale:** the audit confirmed `scope` (`global | project | environment | tool | session`) is not exposed as a filter on any read-path tool. It was advisory metadata with no consumer. `domain` subsumes its intended purpose.
- **Removed surface:**
  - `scope` column on `memories`
  - `Scope` enum
  - `scope` field in `normalizeMemoryInput`
  - `scope` parameter in `listMemories`

### 4.8 Conversation-state registry

A new server-side keyed store for per-conversation runtime state.

- **Storage:** new table `conversation_state`:
  ```sql
  CREATE TABLE conversation_state (
    conv_id TEXT PRIMARY KEY,
    harness TEXT NOT NULL,
    domain TEXT NOT NULL,
    session_id TEXT,
    off_record INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  ```
- **`conv_id` is harness-supplied.** Each integration is responsible for providing a stable conversation identifier. For Claude Code: the value of `CLAUDE_SESSION_ID`. For Hermes: `<channel-id>:<thread-id>`. New integrations must specify their `conv_id` convention.
- **MCP/HTTP surface:**
  - `conv_state.get(conv_id)` — returns current state or `null`
  - `conv_state.upsert(conv_id, patch)` — creates or updates
  - `conv_state.clear(conv_id)` — for explicit teardown (e.g. end of conversation)
- **The registry is *not* a session.** It is ephemeral per-conversation runtime state. Sessions remain the durable, human-curated work artefact.

### 4.9 Hook contract — per-turn state injection

Every harness integration that uses the domain model must implement a `before-user-message` hook (or harness equivalent) that:

1. Reads the stable `conv_id` from harness environment.
2. Calls `conv_state.get(conv_id)`.
3. Injects a system reminder of the form:
   ```
   <conversation-state>
     conv_id: <id>
     domain: <domain>
     session_id: <id or none>
     off_record: <true|false>
   </conversation-state>
   ```

This re-injection on every turn is what defeats context compaction. The conv-state is restored from outside the prompt every time the LLM is invoked, so the state cannot fall out of the context window.

For Claude Code, this uses the existing `UserPromptSubmit` hook mechanism (same machinery that powers `/lib-toggle-private`).

### 4.10 Session-start prompt — signal-precedence chain

When a harness detects the start of a new conversation (no existing `conv_state` for the `conv_id`), it runs the precedence chain to determine the initial domain:

1. **Token-bound default.** If the owner has registered the calling token as bound to a specific domain (e.g. `research-bot-token → research`), assign that domain. No prompt. **Highest precedence.**
2. **Source signal.** The harness supplies a signal string (cwd, channel-id, etc.). The dashboard stores `{harness, signal-pattern} → domain` rules. First matching rule wins; the matched domain is pre-selected for the prompt.
3. **Recency.** The owner's most recently used domain in this harness becomes the pre-selected default.
4. **Manual prompt.** The owner is shown the domain picker with the pre-selection from steps 2/3 (or no pre-selection). Always available as an override.

**Special case:** if the domain list contains exactly one entry, the entire chain is skipped. The single domain is assigned automatically. This is the zero-friction baseline for owners who do not partition.

### 4.11 Recall — hard filter with explicit broaden

`recall` and equivalent read-path tools apply the following filter:

```
WHERE (domain = :current_domain OR is_global = 1)
  AND status = 'active'
```

`current_domain` is read from `conv_state` by the server (not supplied by the agent). Admin callers bypass the domain filter entirely.

New inputs on `recall`:

- `include_other_domains: boolean` (default `false`). When `true`, the domain filter is dropped. Globals are always included. This is the only way for an agent to see cross-domain memories during a domain-bound conversation. The flag is per-call; it does not persist or change `conv_state`.
- `tags: array<string>` (new). Filters results to memories carrying any of the listed tags. Replaces the retired `categories: []` input.

Retired inputs:
- `include_private` — removed (no replacement; visibility no longer exists).
- `categories` — removed (no replacement at the category level; use `tags` for semantic filtering).

### 4.12 Sessions and resume — D10

Sessions carry their own `domain`:

- **Storage:** new column `domain TEXT NOT NULL DEFAULT 'general'` on `sessions`.
- **Set at `start_session`:** inherited from the creating conv-state's domain. Defaults to `general` if no conv-state (e.g. CLI-initiated session).
- **Immutable for the session's life.** Sessions cannot change domain mid-flight (consistent with §4.13).
- **Resume semantics:** `/lib-session-resume <id>` into a new harness/conversation creates (or overwrites) the new `conv_state` with `domain = session.domain`. The signal-precedence chain is **skipped** on resume — the user's resume action is itself the signal of intent.

### 4.13 No mid-conversation domain switching

Conversations are bound to a single domain for their life. If work drifts to a different domain, the owner starts a new conversation. This keeps the model predictable and discourages sloppy session bounding.

A future iteration may add an explicit slash-command to switch, but the current default is no-switching.

### 4.14 Outside-session memories — proposal flow

Memories created without a `conv_state` context (curator job, scheduled agents, direct CLI/API, dashboard writes) do not auto-assign a domain. They are routed to the proposal queue with `domain = NULL`. The write-path classifier still runs and sets `is_global` / `requires_approval` as it would for any other write; `requires_approval` is forced to `true` for outside-session writes regardless of the classifier's verdict, since the absence of a conv-state is itself a signal that owner review is warranted.

The dashboard's proposal approval flow gains a domain selector:

- **If the proposal already has `domain` set** (e.g. inherited from source memories during curator distillation — see §4.15), **Approve** is one-click.
- **If `domain` is `NULL`**, **Approve** opens a small modal requiring the owner to pick a domain before the approval lands.

**Reject** remains one-click in both cases.

### 4.15 Curator distillation — source-domain inheritance

When the curator creates a candidate memory derived from N source memories:

- **If all sources share a domain**, the proposal is created with that domain pre-set. Owner approval is one-click.
- **If sources span multiple domains**, the proposal is created with `domain = NULL`. Owner picks at approval time.

The classifier still runs on curator-distilled candidates. Its `is_global` / `requires_approval` verdicts apply normally; the source-inheritance rule only concerns `domain`.

---

## 5. Tech stack

One new infrastructure component: the write-path classifier. Otherwise no new dependencies. Changes live in:

- `@librarian/core` — schemas (`memory.ts`, new `conversation-state.ts`), store (`memory-store.ts`, new `conversation-state-store.ts`), projection (`projection.ts`).
- `@librarian/mcp-server` — tool handlers (`recall.ts`, `remember.ts`, `start_session.ts`), new dispatch surface for `conv_state.*` tools, hook-injection helpers, classifier client.
- **New: `@librarian/classifier`** — owns the background worker, the provider router (local vs remote OpenAI-compatible), the prompt files, the JSON parser, and the retry + giveup logic. **New: `@librarian/classifier-eval`** — owns the dashboard-driven evaluation tool and the synthetic-fixture generator. The classifier implementation, model choice, provider configuration, and evaluation design are pinned by the [classifier implementation spec](./023-classifier-implementation-spec.md).
- `apps/dashboard` — new `/domains` page, signal-rules page, proposal-approval modal, memory detail panel gains a `domain` field and `is_global` / `requires_approval` toggles, new tag-based grouping replaces the category-based views.
- `packages/cli` — wrapper updated to read `conv_id` from env and pass to MCP.
- `packages/lifecycle` and the sibling Claude/Hermes plugin repos — implement the per-turn hook contract from §4.9.
- New script: `scripts/migrate-add-domain-and-conv-state.mjs` (see §7).

---

## 6. Decisions (resolved)

Each item below was settled during the design session. Decision IDs match the working doc.

- **D1.** Spec scope is *memories only*. Sessions are owner-initiated for resume; cross-harness state transfer for sessions is a separate concern.
- **D2.** Partitioning is desirable. Retrieval-quality alone is insufficient: scoping serves both retrieval tractability (top-K competition) and defence-in-depth against asymmetric leakage (personal context into code artefacts).
- **D3.** Agent-name as the unit of scoping is dead. The unit must be owner-controlled, not agent-self-declared.
- **D4.** Recall hard-filters by domain. `include_other_domains: true` is the only broaden path.
- **D5.** Some memories bypass the domain filter. Expressed as a per-memory `is_global` boolean. (Originally "defaulted by category" — superseded by D18: now set by the write-path classifier.)
- **D6.** Outside-session writes route to the proposal queue with `domain = NULL` (or inherited from sources). Approval requires domain assignment.
- **D7.** No mid-conversation domain switching.
- **D8.** Single-column storage. Single-domain installs skip the prompt entirely.
- **D9.** The session-start prompt is harness-hook driven, not coupled to Librarian session lifecycle.
- **D10.** Sessions carry their own `domain`. Resume seeds the new conv-state from `session.domain` and skips the signal-precedence chain.
- **D11.** Agents cannot set `is_global` directly. It is server-derived (originally from category; per D18, by the classifier). Owner promotion is via dashboard.
- **D12.** Dashboard surface for domain management is a flat list of strings. No hierarchies, colours, or per-domain settings in V1.
- **D13.** Proposal approval is one-click when `domain` is already set; modal-with-picker only when `domain` is `NULL`.
- **D15.** `visibility` is removed entirely. Privacy is owner-controlled via domains, not agent-self-declared. The `Visibility` enum, the `visibility` column, `include_private` on `recall`, and all related filtering logic are deleted.
- **D16.** *(Superseded by D18.)* Original: `identity` and `relationship` collapse into a single category `profile`. Replaced by: drop `category` entirely; the protection-routing behaviour previously triggered by `identity`/`relationship` is now expressed via `requires_approval`, which is set by the classifier.
- **D17.** `scope` is removed entirely. The `Scope` enum, the `scope` column on `memories`, the field in `normalizeMemoryInput`, and the `scope` parameter in `listMemories` are deleted. The audit confirmed `scope` is not exposed as a filter on any read-path tool; it was advisory metadata with no consumer. `domain` subsumes its intended purpose.
- **D18.** `category` is removed entirely. Policy moves to two booleans: `is_global` and `requires_approval`. Semantic labels (`tools`, `lessons`, `people`, ...) move to the existing `tags[]` array. Migration converts each former category value into a tag and derives the booleans from the old category at the cutover point; thereafter the classifier is the source of truth for new writes.
- **D19.** A write-path classifier sets `is_global` and `requires_approval` on every new memory. **Async, not sync** — `remember` returns instantly at conservative defaults; a background worker classifies and updates the row when the verdict lands. Owner overrides via the dashboard are the ground truth; classifier verdicts are preserved alongside for evaluation. (Originally specified sync with ≤500ms timeout; revised when the [classifier implementation spec](./023-classifier-implementation-spec.md) surfaced the async architecture.)
- **D20.** **Conservative defaults at write time**: `requires_approval = true`, `is_global = false`. Same values the sync design used as a fallback are now the *default* until classification commits. The classifier worker either replaces them with a real verdict, or — after 3 failed 30s attempts — leaves them in place and emits `memory.classified` with `fallback_used: "max_retries"`. Either way the memory ends up reviewable in the dashboard if `requires_approval=true` survives.
- **D21.** **Configurable classifier provider.** Local (default, in-process via node-llama-cpp) or remote (OpenAI-compatible HTTP API, reusing the curator's LLM-client code with a separate config namespace). Admins on low-spec hardware can lean on a remote endpoint; default installs are self-contained. (Originally specified local-only; revised when the implementation spec confirmed the curator already had the right LLM-client abstraction for reuse.)
- **D22.** Outside-session memories (no `conv_state`) force `requires_approval = true` regardless of classifier verdict. The absence of a conv-state is itself a signal that owner review is warranted.

---

## 7. Migration

A one-shot script: `scripts/migrate-add-domain-and-conv-state.mjs`.

Following the precedent of `scripts/replay-verify-outcomes.mjs` (from the memory-simplification rollout), the script is idempotent and works against the canonical instance.

### 7.1 Schema changes (end-state)

The end-state schema after PR 7. Additions land in PR 1; drops land in PR 7. See §7.3 for the per-PR breakdown.

- `memories` table:
  - **Add (PR 1)** `domain TEXT NOT NULL DEFAULT 'general'`
  - **Add (PR 1)** `is_global INTEGER NOT NULL DEFAULT 0`
  - **Add (PR 1)** `requires_approval INTEGER NOT NULL DEFAULT 0`
  - **Drop (PR 7)** `category` column
  - **Drop (PR 7)** `visibility` column
  - **Drop (PR 7)** `scope` column
- `sessions` table — **add (PR 1)** `domain TEXT NOT NULL DEFAULT 'general'`.
- New `conversation_state` table (see §4.8).
- New `domains` table:
  ```sql
  CREATE TABLE domains (
    name TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );
  -- seeded with one row: ('general', <now>)
  ```
- New `signal_rules` table:
  ```sql
  CREATE TABLE signal_rules (
    id TEXT PRIMARY KEY,
    harness TEXT NOT NULL,
    pattern TEXT NOT NULL,
    domain TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0
  );
  ```
- New `token_domain_bindings` table:
  ```sql
  CREATE TABLE token_domain_bindings (
    token_id TEXT PRIMARY KEY,
    domain TEXT NOT NULL
  );
  ```

### 7.2 Historical JSONL cleanup

The script reads `events.jsonl` and `sessions.jsonl` and produces a normalised projection without rewriting the ledger (ledger remains byte-compatible — old events parse unchanged).

For each `memory.created` event in `events.jsonl`:

1. **Convert category to tag.** Append the original category value to the memory's `tags[]` (deduped). For `identity` and `relationship`, append the tag `profile` (collapsing the two into one tag to match the spec's previous intermediate state).
2. **Derive `requires_approval`** from the original category:
   - `identity | relationship` → `requires_approval = 1`
   - else → `requires_approval = 0`
   This preserves the protected-routing behaviour for already-existing memories. The classifier is only authoritative for *new* writes post-cutover; historical memories keep the routing they were created under.
3. **Derive `is_global`** from the original category:
   - `identity | relationship | preferences` → `is_global = 1`
   - else → `is_global = 0`
4. **Assign `domain`:**
   - **If the memory's original `visibility` was `agent_private`:** assign `domain = 'legacy-private'`. The migration creates this domain automatically and adds it to the `domains` table. Rationale: agent-private memories were created with an expectation of restricted visibility; silently merging them into `general` would surface formerly-private content unexpectedly. The owner can review the `legacy-private` domain post-migration and re-route, archive, or rename as they prefer.
   - **Otherwise:** assign `domain = 'general'`.
5. **Drop the `category`, `visibility`, and `scope` fields** from the projection row. The columns no longer exist in the new schema. The ledger events remain unchanged — the projection handler ignores those fields when replaying old events.

The classifier is **not** retroactively run on historical memories during migration. Doing so would risk reclassifying long-stable memories under a model whose calibration has not yet been validated. A separate, opt-in "reclassify-all" admin tool can be added later if the owner wants the classifier's verdict applied retrospectively.

For each `session.started` event in `sessions.jsonl`:

1. Assign `domain = 'general'`. (Sessions never had a `visibility` field, so there is nothing to migrate.)

The script:

- Is idempotent. Running twice produces the same projection. Re-running after manual domain assignment by the owner does not overwrite owner-set values (uses `INSERT OR IGNORE` semantics).
- Logs counts: memories backfilled, sessions backfilled, conv-state entries created (zero — conv-state starts empty).
- Does not write any new events to `events.jsonl`. The projection is the source of the new shape; the ledger remains the historical source of truth for everything prior.

### 7.3 Rollout order

The classifier is load-bearing for the category drop, so it must ship before the cutover that removes `category`. The intermediate state keeps `category` alongside the two new booleans, with the booleans derived from category until the classifier takes over.

1. **PR 1 — Additive schema.** Add `domain`, `is_global`, `requires_approval` columns (with defaults); add `conversation_state`, `domains`, `signal_rules`, `token_domain_bindings` tables; add `domain` to `sessions`. Keep `category`, `visibility`, `scope` columns in place for now. Existing reads/writes continue to work. Booleans are derived from category (legacy logic). Releasable.
2. **PR 2 — `conv_state` registry + MCP tools + hook helpers.** Server-side machinery for §4.8 and §4.9. No harness integrations consume it yet. Releasable.
3. **PR 3 — Domain enforcement in `recall` and `remember`.** Server reads `conv_state.domain` when present; falls back to `general` when not. Single-domain installs experience no change. Releasable.
4. **PR 4 — Dashboard surface.** Domain list page, signal rules page, proposal modal, memory detail panel additions (including `is_global` / `requires_approval` toggles), classifier-evaluation page (the dashboard tool from classifier-spec §4.6). Releasable.
5. **PR 5 — Harness integrations.** Claude Code hook, Hermes hook, CLI wrapper updates. Each integration is its own PR in its own repo. Releasable.
6. **PR 6 — Classifier + cutover (single PR).** Ships `@librarian/classifier` + `@librarian/classifier-eval`, the async worker, the new `classified` + `classification_attempts` columns, the configurable provider, and the deletion of the category-derived bridge. Migration backfills existing memories so the classifier's real-data quality is visible from day one. Originally split as PR 6 (shadow) + PR 7 (cutover); collapsed into one because the eval design (dashboard-driven, operator-judged) doesn't need a shadow-mode telemetry phase to gate the cutover. The classifier becomes source of truth from merge time. The migration script (from PR 1) is re-run to convert `category` values into tags and remove the column. `category`, `visibility`, and `scope` columns are dropped in the same PR. Releasable; the eval page lets the operator validate quality before and after the backfill completes.
7. **PR 7 — Documentation.** Update integration docs, `/lib-session-*` command help, agent-facing CLAUDE.md / SOUL.md guidance, classifier prompt documentation. (Was PR 8 in the original eight-PR plan; renumbered after PR 6 + 7 collapsed.)

---

## 8. Success criteria

Concrete, testable conditions for "done":

- [ ] Out-of-box install (one domain, no signal rules, no token bindings) prompts the user for **nothing** at session start; all memories save and recall with `domain=general`; behaviour is indistinguishable from pre-spec behaviour from the user's perspective.
- [ ] An owner who adds a second domain via the dashboard sees the session-start prompt fire on the next new conversation. Choosing a domain causes subsequent `remember` writes to be tagged with it.
- [ ] An owner with rules `cwd ~/code/* → coding` and `channel-id 12345 → family` sees the correct pre-selection in each context.
- [ ] A `coding` session's `recall` returns coding-domain memories and global memories; does not return `family-admin`-domain memories. Setting `include_other_domains: true` returns all.
- [ ] Cross-harness resume of a `coding` session into a Hermes conversation establishes `conv_state.domain = coding` for the new conv-id without prompting.
- [ ] A long Claude Code conversation that triggers context compaction continues to operate with the correct `domain` and `session_id` after compaction — verified by inspecting the system-reminder injected on the next turn.
- [ ] A curator-produced proposal whose source memories all have `domain=coding` arrives in the proposal queue with `domain=coding` pre-set, approvable in one click.
- [ ] A curator-produced proposal whose source memories span domains arrives with `domain=NULL` and cannot be approved without an explicit pick.
- [ ] An agent attempting to set `is_global`, `requires_approval`, `visibility`, `category`, or `scope` in a `remember` call has all those fields ignored. The MCP tool input schema for `remember` no longer advertises any of them.
- [ ] `remember` returns "Memory saved" in under 50ms p99, with the row persisted at conservative defaults and queued for classification. A `memory.classified` event is appended to `events.jsonl` once the background worker decides — capturing input, provider, model, prompt version, raw output, parsed booleans, queue_wait_ms, inference_ms, attempt_number, and the fallback flag.
- [ ] When the classifier provider is unreachable, the background worker retries (30s per attempt, 3 attempts). After the third failed attempt, the memory ends up at `classified=1` with conservative defaults persisted and a `memory.classified` event carrying `fallback_used: "max_retries"`. `remember` is never blocked by classifier failures.
- [ ] An owner toggling `is_global` or `requires_approval` on a memory via the dashboard records a `memory.classification_overridden` event preserving the classifier's original verdict.
- [ ] Existing memories that were category `identity` or `relationship` arrive post-migration with the legacy-derived booleans in place; the PR 6 backfill subsequently re-classifies them via the production classifier, overwriting the legacy values with the classifier's verdicts.
- [ ] Existing `agent_private` memories appear in a domain called `legacy-private` after migration; the owner sees one prompt to review them on first dashboard load post-migration.
- [ ] After PR 6 (classifier + cutover), the `memories` table has no `category`, `visibility`, or `scope` columns. Reading an old `memory.created` event from `events.jsonl` does not crash the projection.
- [ ] Migration script run twice produces identical results.

---

## 9. Open questions

**Resolved in follow-up specs:**

- **Classifier implementation details.** Closed by [`023-classifier-implementation-spec.md`](./023-classifier-implementation-spec.md). Async lifecycle, configurable provider (local default LFM2.5-1.2B-Thinking-GGUF via node-llama-cpp, or remote OpenAI-compatible API), prompt-file versioning, dashboard-driven evaluation against a 1000-item synthetic fixture, single-PR rollout with backfill at migration time.

**Deferred to future iterations:**

- **Retroactive reclassification.** An admin tool to run the classifier over historical memories and surface disagreements with the migrated derived values. Useful once classifier quality is well-understood. Out of scope for V1.
- **Tag-based classifier assistance.** The classifier could also propose `tags[]` to reduce agent-driven tag inconsistency, in the same spirit as the booleans. Out of scope for V1 — agents continue to set their own tags.
- **Mid-conversation domain switching.** D7 forbids it for V1. Real usage may surface a need; revisit if so.
- **Domain hierarchies / metadata.** D12 keeps the dashboard surface flat for V1. Add structure if usage justifies it.
- **`agent_id` ownership enforcement on update.** Surfaced in the audit — any caller holding a memory id can patch its `agent_id`. Out of scope for this spec but should be addressed separately.
- **Per-domain capability gates.** Domains scope memory only, not tool access. If we ever want "the family-admin domain cannot call `archive_memory`", that's a separate RBAC spec.
