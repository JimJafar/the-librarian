# Spec: Memory Curator

**Author:** Guybrush, with Jim
**Date:** 2026-05-23
**Status:** Draft — revised after stronger-model review; trigger model, admin cockpit (config + observability + run-now + prompt addendum), model config, apply policy, agent-private, tombstones, and rollout settled in claude-code re-review (2026-05-23)

---

## 1. Purpose

Build an internal **Memory Curator** for The Librarian.

The curator periodically reviews stored memories and existing session evidence, then produces governed memory operations that improve the signal-to-noise ratio of the memory store.

The v1 outcome is simple: agents should receive cleaner, less duplicated, more current context from `start_context` and `recall` without Jim manually pruning memories.

---

## 2. Scope

### In scope for v1

- Deduplicate near-identical memories.
- Merge fragmented memories that belong together.
- Split memories that conflate unrelated facts.
- Archive stale, contradicted, duplicate, or low-signal memories.
- Surface durable facts from stored session summaries, decisions, and candidate memories.
- Run unattended from the scheduled job (admin-configurable interval/time, default every 1 day at 03:00), plus a trusted maintenance path and an admin-only run-now control.
- Apply non-protected operations at the curator's discretion; route protected-category corrections to proposals (annotated with superseded refs) and protected pure-deletions to skip + audit.
- Add a `curator_note` field to the memory record so curator provenance and superseded references travel with proposals/memories.
- Store auditable curation-run and curation-operation records, surfaced in an admin-only observability view.
- Provide an admin-only dashboard surface: enable/disable, LLM config, prompt addendum, observability, run-now.

### Out of scope for v1

- Raw transcript capture.
- Changes to session storage shape.
- Consumer-agent MCP tools for memory curation.
- Consumer-agent slash commands for memory curation.
- A dedicated curation review/approval queue (protected items use the existing proposal lifecycle).
- Cross-project inference.
- Automatic session lifecycle management.
- Rebuilding a whole parallel memory store for review/adoption.

---

## 3. Non-negotiable privacy boundary

An off-record private conversation has **zero interaction with The Librarian**:

- no `start_context`;
- no `start_session`;
- no events;
- no memories;
- no MCP calls;
- no metadata in the store.

The curator therefore has nothing to filter for those conversations. They are absent from the database.

Do not confuse this with existing stored visibility values:

- `common` data may be curated in common slices;
- `agent_private` data may be curated only in that agent-private slice;
- off-record private data is not stored and is never an input.

The curator must never promote `agent_private` data into `common` output unless an explicit governed migration operation is added in a later spec.

---

## 4. Design principles

1. **Internal, not agent-facing.** The MCP tool registry must not include memory-curation management tools or equivalents.
2. **Operation-based, not rewrite-based.** The curator emits explicit memory operations against the existing store.
3. **Auditable.** Every run and operation is recorded, including skipped and failed operations.
4. **Conservative with destructive edits.** Confidence is useful, but not sufficient. Operation type and category determine whether auto-apply is allowed.
5. **Protected memory remains protected.** Identity and relationship changes always become proposals.
6. **Slice-local by default.** Do not merge across projects, agents, or visibility boundaries unless explicitly designed later.
7. **Idempotent.** Re-running on the same evidence should not produce duplicate memories or repeated archive/update churn.
8. **No session mutation.** The curator reads sessions as evidence; it does not alter session rows or session events.

---

## 5. Surfaces

The Memory Curator has **no consumer-agent surface** in v1. The only human surface is the **admin dashboard**, available to trusted admin operators. The governing boundary is:

> **Trusted admins may configure, observe, and manually trigger curation. Consumer agents and ordinary users may not — they only ever see the improved memory quality that results.**

### Allowed surfaces

| Surface | Caller | Purpose |
|---|---|---|
| Scheduler tick | The Librarian process or worker | At the configured interval/time (default daily at 03:00), check which slices are due and run curation. |
| Admin dashboard — configuration | Admin operator only | Enable/disable curation; set the schedule (every N days at HH:MM); set LLM provider, endpoint, token, model; edit the prompt addendum. |
| Admin dashboard — observability | Admin operator only | Read-only view of past runs: timestamp, trigger, slice, and counts by action (archived, merged, split, synthesised, proposed, skipped, failed). |
| Admin dashboard — run now | Admin operator only | Manually start a run for due/selected slices. Recorded under the `manual` trigger for audit. |
| Trusted maintenance path | Deployment/bootstrap/test code | Run bounded maintenance without creating a public command surface. |
| Existing memory/proposal store | Normal memory system | Receive created memories, archived duplicates, and protected-category proposals. |

The scheduled tick (default daily at 03:00, admin-configurable) is the only *unattended* trigger. Beyond it, only a **trusted admin** (run-now) or **trusted internal code** (maintenance) may begin a run. There is no event/threshold trigger — **agent activity must never start a curation run, directly or indirectly.**

### Disallowed surfaces

| Surface | Reason |
|---|---|
| MCP memory-curation tools | Would expose internal maintenance to consumer agents. |
| Agent slash commands | Agents must not control curation runs. |
| Consumer-facing CLI commands | Turns curation into an end-user feature rather than admin-governed hygiene. |
| Non-admin dashboard controls | Run-now / config / observability are admin-only; ordinary users get no curation surface. |
| Prompt-triggered “please curate memories now” behaviour | An agent prompt must never start a run; it would make privacy and audit boundaries fuzzy. |

If a consumer agent is asked to “clean up memories”, it must not call or point to any curation control. It can say that memory hygiene is handled internally by The Librarian, and continue with the user’s actual task. The run-now button is an admin affordance, not something an agent surfaces or invokes.

The only consumer-visible result is better memory quality: cleaner `start_context`, better `recall`, and ordinary memory proposals when protected changes need review.

---

## 6. Proposed implementation structure

All logic lives inside The Librarian repository and trust boundary. Names should say what the feature does: curate memory.

```text
packages/core/src/memory-curator/
  index.ts                 # Internal exports for The Librarian code only
  config.ts                # Config parsing/defaults
  slices.ts                # Select project/global/agent-private slices
  gather.ts                # Gather memories + session evidence
  prepass.ts               # Deterministic duplicate/staleness candidates
  prompt.ts                # LLM prompt builder
  parse-output.ts          # Zod validation and operation normalisation
  apply.ts                 # Apply/propose operations through store methods
  lock.ts                  # Run locking/idempotency helpers
  scheduler.ts             # Due-slice selection and enqueue policy
  worker.ts                # Executes queued/internal curation runs
  types.ts                 # Run, operation, evidence, config types

packages/mcp-server/src/internal-jobs/
  memory-curator.ts        # Starts scheduler/worker inside the trusted server boundary

packages/dashboard/...      # Admin-only curator page + admin API (see below)
  curator settings          # Enable toggle, LLM provider/endpoint/token/model, prompt addendum
  curator observability     # Read-only run/op history with action counts
  curator run-now           # Admin-authenticated POST that enqueues a `manual` run
```

The admin dashboard pieces must sit behind the dashboard's existing **admin authentication/authorisation**, identical to other admin-only settings. The run-now endpoint enqueues a run through the same internal entrypoints as the scheduler — it must not contain its own copy of the curation logic.

Do not add Memory Curator files under any consumer-agent command surface:

- no `packages/mcp-server/src/mcp/tools/*` curation tools;
- no `/lib:*` slash commands;
- no `packages/cli/src/commands/*` consumer curation commands;
- no non-admin dashboard route or button for curation.

---

## 7. Configuration

Configuration splits into two tiers.

### 7.1 Admin-dashboard settings (operator-managed)

The **enable toggle** and the **LLM connection** live in the admin dashboard, not in a static file, because they include a secret (the provider token) and because curation should be switchable without a redeploy.

- Curation is **disabled by default**.
- **Schedule.** Configured as *run every N days at HH:MM*. Default: **every 1 day at 03:00**. The dashboard exposes exactly two inputs — an interval in whole days (≥ 1) and a time of day — never raw cron syntax. The time is interpreted in the deployment's configured timezone. The scheduler computes the next run from the last completed run + interval + time-of-day.
- To enable it, the admin must supply a complete LLM configuration: **provider**, **API endpoint**, **token**, and **model**.
- If curation is enabled but any of provider/endpoint/token/model is missing, curation stays effectively off and the dashboard surfaces the incomplete configuration. The scheduler must never run a curation pass without a complete, validated LLM config.
- The token is stored via The Librarian's existing admin secret-storage mechanism, never in plaintext config or in audit records.
- **Prompt addendum (optional).** A free-text field appended to the curator's prompt so an admin can steer curation (e.g. "be more aggressive about archiving superseded TODOs", "prefer merging over archiving"). It is **length-bounded** (e.g. ≤ 2 KB) and **advisory only**: it influences what the LLM *suggests*, but cannot relax any code-enforced guard — boundary checks, protected-category routing, secret redaction, and the apply policy all run after the LLM returns regardless of addendum content. The addendum text is itself subject to secret redaction before being sent to the provider.

These are **configuration and observability**, plus an explicit admin **run-now** trigger (§5). The dashboard exposes no curation control to non-admins, and an agent prompt can never start a run. See §13 for the observability view.

### 7.2 Operational config (file/env)

Non-secret operational knobs follow The Librarian's existing config/env conventions:

```yaml
memory_curator:
  # schedule is admin-managed (every N days at HH:MM, default every 1 day at 03:00) — see §7.1
  min_sessions_since_run: 10      # Scheduler gate: skip the tick below this
  max_days_since_run: 7           # Scheduler gate: force a run at least weekly
  max_sessions_per_run: 50
  max_memories_per_run: 200
  default_auto_apply: safe_only   # off | safe_only | high_confidence
  auto_apply_confidence: 0.90
  slices:
    common_global: true
    common_project: true
    agent_private: true           # Curated in v1; each agent's slice stays isolated
```

Agent-private slices are curated in v1. Each run is strictly scoped to a single `agent_id`'s private slice, never reads or writes across agents, and never promotes `agent_private` content into `common` output (§3, §11).

The scheduled tick self-gates on `min_sessions_since_run` / `max_days_since_run`, so an idle store produces no curation work and no LLM cost even when the interval comes due.

Rollout posture for v1: `default_auto_apply: safe_only`. Only exact-duplicate archive/merge above the confidence threshold auto-applies; non-protected ops below that bar are skipped + audited, and protected corrections become proposals. Increase automation only after reviewing real output quality.

---

## 8. Data model

Use operation-level tables rather than a single opaque JSON blob. That makes audit, retry, idempotency, and internal filtering much easier.

### `memory_curation_runs`

```sql
CREATE TABLE memory_curation_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,              -- pending | running | completed | failed | cancelled
  trigger TEXT NOT NULL,             -- schedule | manual | maintenance
  mode TEXT NOT NULL DEFAULT 'apply',-- apply | dry_run
  project_key TEXT,
  visibility TEXT NOT NULL,          -- common | agent_private
  agent_id TEXT,                     -- only for agent_private slices
  input_hash TEXT NOT NULL,
  input_memory_ids TEXT NOT NULL,    -- JSON array
  input_session_ids TEXT NOT NULL,   -- JSON array
  model_provider TEXT,
  model_name TEXT,
  usage_input_tokens INTEGER DEFAULT 0,
  usage_output_tokens INTEGER DEFAULT 0,
  summary TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);
```

### `memory_curation_operations`

```sql
CREATE TABLE memory_curation_operations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  operation_type TEXT NOT NULL,       -- noop | create | update | archive | merge | split
  status TEXT NOT NULL,               -- proposed | applied | skipped | failed | superseded
  confidence REAL NOT NULL,
  risk_level TEXT NOT NULL,           -- safe | normal | risky | protected
  source_memory_ids TEXT NOT NULL,    -- JSON array
  source_session_ids TEXT NOT NULL,   -- JSON array
  target_memory_ids TEXT NOT NULL,    -- JSON array of created/updated/proposed memory ids
  title TEXT,
  rationale TEXT NOT NULL,
  proposed_payload TEXT NOT NULL,     -- JSON operation payload
  applied_at TEXT,
  error TEXT,
  FOREIGN KEY (run_id) REFERENCES memory_curation_runs(id)
);
```

The existing memory/event store remains authoritative for memory state. These tables explain why a curator suggested or performed an operation.

### Memory-store addition: `curator_note`

Add one nullable field to the **memory record** (which, per the three-state model, also covers `proposed` memories):

```sql
ALTER TABLE memories ADD COLUMN curator_note TEXT;  -- nullable JSON
```

`curator_note` carries curator provenance and, crucially, the **superseded reference** that makes a protected-correction proposal actionable:

```jsonc
{
  "text": "Supersedes the older relationship note; the title/role changed after the 2026-05 reorg.",
  "supersedes": ["mem_abc123"],     // memory ids this proposal is meant to replace
  "run_id": "run_…",                // provenance: which curation run produced this
  "operation_id": "op_…"
}
```

- For a **protected correction** proposal, the apply layer populates `curator_note` from the operation (rationale + `source_memory_ids` → `supersedes`). The dashboard reads `supersedes` to render "accept this → then archive mem_abc123" and to warn if the superseded memory is still active after acceptance.
- For an **auto-applied non-protected create**, `curator_note` may record lightweight provenance (`run_id`, `operation_id`) so curator-authored memories are distinguishable from agent-authored ones.
- This is the **only** change to the memory store. It does not touch session storage.

---

## 9. Evidence gathering

A curation run gathers a bounded evidence bundle for one slice.

### Common project slice

- active `common` memories where `project_key = X`;
- proposed `common` memories where `project_key = X`;
- archived memory tombstones for `project_key = X` (id, title, category, archived date, archive reason, and a **normalized content fingerprint**; full body excluded — see §9.1);
- sessions with `project_key = X` and `visibility = common`;
- session summaries, decisions, candidate memories, files touched, commands run.

### Common global slice

- active/proposed/tombstone memories with global scope or null project;
- stored sessions only if explicitly global/null project and common visibility.

### Agent-private slice

- same shape as above, but only for the specific `agent_id` and `visibility = agent_private`;
- enabled in v1; each run is scoped to exactly one `agent_id` and never reads another agent's private data.

### 9.1 Tombstone fingerprints (resurrection prevention)

Archived memories are passed to the prompt as **metadata-only tombstones** — id, title, category, slice, archived date, archive reason — plus a `content_fingerprint`: a hash of the normalized title+body (lowercased, whitespace-collapsed, punctuation-stripped). The full archived body is **not** sent to the LLM, so deliberately deleted content is not re-exposed.

The deterministic pre-pass (§10.3) computes the same fingerprint for each new `create`/`merge` candidate and blocks any operation whose fingerprint or normalized title matches an existing tombstone. This catches exact and near-exact resurrection cheaply. Paraphrase-level (semantic/embedding) resurrection detection is deferred to v2.

### Evidence caps

Use deterministic ordering and caps:

- sessions: newest eligible first, max `max_sessions_per_run`;
- memories: active first, then proposed, then tombstones;
- session evidence: decisions and candidate memories before long summaries;
- proposed memories: include enough status/context to decide whether to approve, reject, supersede, or leave pending;
- large fields trimmed with explicit markers.

The prompt must know when evidence was truncated.

Before prompt construction, evidence gathering must redact or exclude secret-looking material from memory bodies, session summaries, commands run, file paths, and metadata. Do not wait until output validation to catch secrets; by then the sensitive value may already have been sent to an LLM.

---

## 10. Execution pipeline

```text
select due slice
  → acquire slice lock
  → gather evidence
  → compute input hash
  → skip if identical completed run exists
  → deterministic pre-pass
  → LLM operation proposal
  → validate and normalise operations
  → risk-classify operations
  → apply/propose/skip operations
  → record run summary and metrics
  → release lock
```

### 10.1 Locking

Only one run may execute for the same slice at a time. Use a database-backed lock or transaction guard. This protects against duplicate jobs when multiple scheduler/worker instances overlap.

Locks need stale-run recovery. Record a heartbeat/updated timestamp and a configurable TTL; a later worker may mark a run failed and reclaim the lock only after the TTL expires. A crashed worker must not block a slice forever.

### 10.2 Input hash

The input hash should include:

- slice identifiers;
- memory ids + updated timestamps + statuses;
- session ids + updated/last activity timestamps;
- candidate memory content hashes;
- curator prompt/version **and the admin prompt addendum** (so editing the addendum permits a fresh run).

If a completed **apply-mode** run with the same hash exists, skip by default. A `manual` (admin run-now) or `maintenance` run may explicitly bypass the skip, recording its trigger and rationale; this lets an admin force a re-run after changing the addendum or model.

Dry-runs must not satisfy idempotency for later real runs. Store `mode = dry_run` on dry-run records and ignore those rows when deciding whether an apply-mode run has already completed.

### 10.3 Deterministic pre-pass

Before calling an LLM, generate cheap candidates:

- exact title/body duplicates after normalisation;
- same title, near-identical body;
- obvious obsolete “considering/maybe” memories contradicted by later decisions;
- proposed memories matching active memories;
- candidates whose content fingerprint or normalized title matches an archived tombstone (§9.1) — flagged as resurrection risks to suppress.

The LLM receives these candidates instead of discovering everything from scratch.

### 10.4 LLM pass

The LLM produces structured JSON only. No prose parsing.

The prompt is assembled as: fixed curator system instructions → slice evidence + pre-pass candidates → **admin prompt addendum** (if set, §7.1). The addendum is positioned as operator guidance, never as authority to override the output schema or the apply policy. Whatever the LLM returns, §10.5 validation and §11 apply policy are enforced in code, so the addendum can only influence *which valid operations are suggested*, not bypass any guard.

Required properties per operation:

```ts
type CuratorOperation =
  | { type: "noop"; source_memory_ids: string[]; rationale: string; confidence: number }
  | { type: "archive"; source_memory_ids: string[]; source_session_ids?: string[]; rationale: string; confidence: number }
  | { type: "update"; source_memory_id: string; patch: MemoryPatch; rationale: string; confidence: number }
  | { type: "merge"; source_memory_ids: string[]; replacement: MemoryInput; rationale: string; confidence: number }
  | { type: "split"; source_memory_id: string; replacements: MemoryInput[]; rationale: string; confidence: number }
  | { type: "create"; source_session_ids: string[]; memory: MemoryInput; rationale: string; confidence: number };
```

`MemoryInput` must use the existing memory fields: title, body, category, visibility, scope, project_key, applies_to, priority, confidence, tags.

### 10.5 Validation

Reject, skip, or route to review when:

- referenced memory/session ids are not in the evidence bundle;
- replacement memory changes visibility, project, scope, owning agent, or other slice boundary unexpectedly;
- category is protected according to the store’s central protected-category list;
- confidence is outside `0..1`;
- operation has no rationale;
- operation would create an empty or duplicate memory;
- operation attempts to use secret-looking strings or raw credentials.

Boundary-changing operations are invalid/skipped in v1. Do not silently turn them into proposals; cross-boundary promotion needs its own future governed migration design.

Protected-category operations are never auto-applied. A protected `create`, `update`, `merge`, or `split` becomes a **proposal** through the same protected-memory governance path used by normal memory writes, with `curator_note.supersedes` set to any existing memory it should replace. A protected **pure `archive`** (deletion with no replacement) has no memory to propose, so it is skipped and audited for manual admin action (§11).

Secret-looking values should cause the operation to be skipped and logged for review, not written to memory. Evidence gathering should already have redacted such values before the LLM pass.

---

## 11. Apply policy

The curator follows **the same governance the rest of the memory system already uses**: protected categories (`identity`, `relationship`, and anything on the store's central protected list) require a proposal; everything else is the curator's discretion to apply directly — exactly as ordinary agents may write non-protected memories without approval. There is no elaborate per-operation proposal routing.

Two hard, code-enforced guards sit above that discretion and cannot be relaxed by confidence, category, or prompt addendum:

- **Slice-boundary guard** — any operation that would change visibility/project/scope/owning agent, or otherwise cross a slice boundary, is **invalid/skipped**. Cross-boundary promotion needs its own future governed migration design.
- **Secret guard** — any operation referencing secret-looking strings is **skipped and logged**, never written. (Evidence gathering should already have redacted these before the LLM pass.)

Within those guards:

| Condition | Result |
|---|---|
| Protected category (`identity`, `relationship`, central list) — `create`/`update`/`merge`/`split` | Routed to an ordinary memory **proposal** for the new/corrected memory, with `curator_note.supersedes` referencing any existing memory it replaces; never auto-applied. Admin rejects, or accepts and then archives the superseded memory. |
| Protected category — pure `archive` (deletion, no replacement) | **skip + audit** — no replacement memory exists to propose; recorded as a recommendation for manual admin action. |
| Non-protected operation, confidence ≥ threshold, permitted by current `default_auto_apply` level | **Auto-apply** via normal store methods. |
| Non-protected operation, below threshold or above current `default_auto_apply` level | **Skip + audit** (recorded as a suggestion; not turned into a proposal). |
| Malformed/unsafe operation | **Skip + record.** |

The `default_auto_apply` level (admin/config) sets how much non-protected discretion the curator exercises:

- `off` — apply nothing; record every suggested operation as audit-only. Pure observation.
- `safe_only` (v1 default) — auto-apply only high-confidence **safe** operations: exact-duplicate archive/merge (same category/scope/visibility/project/owner, compatible `applies_to`) and strong-evidence `create`. Skip + audit everything else (semantic updates, fuzzy merges, splits).
- `high_confidence` — auto-apply **any** non-protected operation at/above the confidence threshold, including `update`/`merge`/`split`. Below threshold → skip + audit.

Auto-applied operations must still use normal store methods — archive via the memory archive pathway, create via the memory creation pathway, update via the memory update pathway, merge/split as create+archive sequences with operation ids recorded. **Never** bypass the store with raw SQL for memory mutations.

For non-protected `merge`/`split`/`update`, the superseded source memories are archived **as part of the same operation** — there is never a window where the old and new memories are both active. The keep-old-until-the-admin-acts two-step is unique to **protected** proposals (where the curator may not archive the original itself).

### 11.1 No curation review queue

There is no dedicated curation review queue in v1. Outcomes are exactly three:

- **auto-apply** — non-protected operations the curator is confident enough to make directly;
- **proposal** — every protected `create`/`update`/`merge`/`split`, expressed through the *existing* memory-proposal lifecycle as a new/corrected memory carrying `curator_note.supersedes`. The admin rejects it, or accepts it and then archives the referenced memory. No bespoke curation approval surface is introduced — this is the same proposal queue the rest of the memory system uses;
- **skip + audit** — non-protected ops below the apply bar, and protected pure-deletions, recorded in the curation tables and visible only in the admin observability view.

A non-protected operation never becomes a proposal — if the curator isn't confident enough to apply it, it is logged, not queued. If a future design wants a richer review queue (e.g. one-click apply for skipped suggestions, or auto-archive of the superseded memory on accept), it must be specified separately; do not smuggle one in for v1.

Proposed memories included as evidence need their own lifecycle handling. A curator may *suggest* that an existing proposal is duplicate or stale, but it must not approve, reject, supersede, or merge an existing proposal unless the apply code explicitly supports that transition through the normal proposal store methods.

Agent-private runs must enforce ownership from the run slice. `MemoryInput` does not carry ownership by itself; apply methods must pass the run's `agent_id` and reject any operation that attempts to create/update another agent's private memory.

---

## 12. Trigger contract

There is deliberately no Memory Curator MCP tool, slash command, or consumer CLI. The only human trigger is the **admin run-now** control in the dashboard; everything else is internal.

Curation is started through a single set of internal entrypoints. The admin run-now endpoint and the scheduler both call the *same* enqueue path — run-now must not reimplement curation logic:

```ts
scheduleMemoryCurationTick(now: Date): Promise<void>
enqueueDueMemoryCurationRuns(reason: "schedule" | "manual" | "maintenance"): Promise<void>
runMemoryCurationWorker(): Promise<void>
```

These functions are imported by the trusted Librarian server/worker runtime, the admin API, and tests. They are not wrapped as consumer-facing commands.

Allowed trigger values:

| Trigger | Source | Notes |
|---|---|---|
| `schedule` | Internal scheduler tick at the admin-configured interval/time (default every 1 day at 03:00) | The only unattended trigger. Self-gates on `min_sessions_since_run` / `max_days_since_run`. |
| `manual` | Admin run-now (authenticated dashboard action) | Trusted admin only. May bypass the input-hash skip (§10.2). Never reachable by a consumer agent or ordinary user. |
| `maintenance` | Trusted deployment/bootstrap/test path | For bounded internal maintenance only; not exposed as a consumer command. |

There is deliberately **no evidence/threshold trigger** in v1. Curation must not be startable by agent activity, directly or indirectly — only the clock (`schedule`), a trusted admin (`manual`), or trusted internal code (`maintenance`) may begin a run.

The implementation should keep all curation controls behind module boundaries, config, and admin authorisation — never behind a consumer-reachable request handler.

---

## 13. Observability (admin)

v1 ships a **read-only admin observability view** in the dashboard, backed by the `memory_curation_runs` / `memory_curation_operations` tables. It is admin-only and shows, per run:

- timestamp, trigger (`schedule` | `manual` | `maintenance`), slice, status;
- **counts by action**: archived, merged, split, synthesised (`create`), proposed, skipped, failed;
- run summary and token usage;
- the operation list with type, status, risk, and rationale (so an admin can see *why* something was done or skipped);
- memory ids created/updated/archived.

This view is the MVP observability requirement: an admin can open it and see, at a glance, when curation last ran and what it did. It is **read-only** apart from the explicit **run-now** control (§5, §12); there is no "force", "replay", "edit operation", or "approve curation op" action in v1. Curation results that need human action surface only as ordinary memory proposals (protected categories) — never as a bespoke curation approval queue.

Curation must also remain observable through ordinary logs and database records for non-dashboard contexts (CI, debugging).

---

## 14. Scheduler/worker

Preferred v1 deployment:

- start a single internal scheduler/worker from The Librarian server process, or from a trusted worker process in the same deployment;
- the scheduler fires at the admin-configured interval and time (default every 1 day at 03:00) and decides which slices are due based on config and last completed runs;
- worker executes queued runs behind database locks.

The scheduler must be safe if started in more than one process. Locking and input-hash idempotency are required.

---

## 15. Testing strategy

### Unit tests

- the scheduler computes the next run from interval_days + time_of_day; default is every 1 day at 03:00; a due interval with too few new sessions still self-gates;
- slice selection respects project, visibility, and agent boundaries;
- evidence gathering excludes off-slice data;
- evidence gathering redacts secret-looking values before prompt construction;
- archived tombstones are included only as metadata + content fingerprint, never full body;
- deterministic pre-pass detects exact duplicates;
- pre-pass blocks a candidate whose fingerprint/normalized title matches a tombstone (resurrection prevention);
- output parser rejects malformed operations;
- protected `create`/`update`/`merge`/`split` route to proposals with `curator_note.supersedes` set; protected pure-`archive` is skipped + audited;
- non-protected ops are never turned into proposals (apply or skip + audit only);
- `default_auto_apply` levels gate correctly: `off` applies nothing, `safe_only` applies only safe ops, `high_confidence` applies any non-protected op ≥ threshold;
- apply policy never crosses visibility/project boundaries;
- agent-private apply paths enforce the run owner `agent_id`;
- the prompt addendum is length-bounded, redacted, and cannot cause a boundary-crossing/protected/secret op to be applied;
- the input hash changes when the addendum changes;
- idempotency skips identical completed input hash; `manual`/`maintenance` may bypass the skip;
- dry-runs do not cause later apply-mode runs to skip;
- lock prevents concurrent same-slice runs;
- stale lock TTL allows crash recovery.

### Integration tests

- seeded SQLite run deduplicates two ordinary project memories;
- strong-evidence session decision auto-creates a non-protected project memory under `safe_only`;
- protected identity candidate becomes a proposal;
- protected `update`/`merge` of an existing memory becomes a proposal whose `curator_note.supersedes` references the old memory id (the old memory stays active until the admin archives it);
- protected pure-`archive` produces a skip + audit record and no proposal;
- exact duplicate archive is auto-applied under `safe_only`;
- low-confidence non-protected update is skipped + audited (neither applied nor proposed);
- under `high_confidence`, a confident non-protected split is applied; under `safe_only` the same split is skipped + audited;
- a candidate matching an archived tombstone is suppressed (no resurrection);
- admin run-now enqueues a run recorded with trigger `manual`;
- the observability view reports correct action counts (archived/merged/split/synthesised/proposed/skipped/failed) for a seeded run;
- dry-run records no memory mutations;
- existing proposed-memory duplicates can be rejected/superseded without treating them as active memories;
- agent-private slice is curated and its operations never touch another agent's slice;
- no MCP curation-management tool appears in `tools/list`.

### Regression tests for earlier contradictions

- private/off-record data is not represented as a stored session in test fixtures;
- `agent_private` evidence never creates `common` output;
- no MCP tool, slash command, consumer CLI, non-admin dashboard control, or prompt-triggered path can start a curation run;
- the run-now endpoint rejects unauthenticated/non-admin callers;
- no evidence/threshold or memory/session write-path hook can enqueue or start a run;
- curation does not run when disabled, nor when the admin LLM config (provider/endpoint/token/model) is incomplete.

---

## 16. Success criteria

v1 is complete when:

- [ ] due curation runs automatically from the scheduled internal scheduler/worker tick (admin-configurable interval/time, default every 1 day at 03:00);
- [ ] curation is disabled by default and only runs when an admin has enabled it with a complete provider/endpoint/token/model configuration;
- [ ] no agent activity can start a curation run, directly or indirectly (no evidence/threshold trigger exists);
- [ ] no consumer-agent MCP, slash command, CLI, or prompt path can start, force, or inspect curation;
- [ ] an authenticated admin can trigger a run (run-now), set the schedule, configure the model, edit the prompt addendum, and view run history with action counts;
- [ ] the prompt addendum steers suggestions but cannot bypass boundary/protected/secret guards;
- [ ] every run and operation is auditable internally and visible in the admin observability view;
- [ ] duplicate memories can be safely merged/archived;
- [ ] conflated memories can be split (auto-applied at `high_confidence`, else recorded as audit-only);
- [ ] durable facts from stored session evidence become ordinary memories (non-protected) or proposals (protected);
- [ ] protected corrections (`create`/`update`/`merge`/`split`) become proposals carrying `curator_note.supersedes`; protected pure-deletions are skip + audit;
- [ ] the memory record has a `curator_note` field and the dashboard renders the superseded reference on a proposal;
- [ ] archived memories are not resurrected (tombstone fingerprint check);
- [ ] curation is slice-local; agent-private slices are curated in isolation;
- [ ] repeated runs on unchanged evidence are idempotent;
- [ ] the only memory-store schema change is the `curator_note` column; no session storage changes are required.

---

## 17. Open questions before implementation

All resolved in the 2026-05-23 claude-code re-review with Jim:

- ~~First production run dry-run/proposal-only by default?~~ → No; v1 ships `default_auto_apply: safe_only`.
- ~~Which model for v1?~~ → No hardcoded model. Provider/endpoint/token/model are configured per-deployment in the admin dashboard; curation is disabled until a complete config is supplied.
- ~~Disable `agent_private` slices at first?~~ → No; agent-private slices are curated in v1, each scoped to one `agent_id` in isolation.
- ~~How much tombstone detail to prevent resurrection?~~ → Metadata + normalized content fingerprint (no full body); pre-pass blocks fingerprint/title matches. Semantic/paraphrase detection is v2.
- ~~Which op types are proposals vs audit-only?~~ → Keep existing governance: only protected categories (identity/relationship) become proposals; all non-protected ops are the curator's discretion (apply or skip + audit), never proposals. Protected corrections (`create`/`update`/`merge`/`split`) are expressed as proposals carrying a `curator_note.supersedes` reference (new memory field) so the admin can accept-then-clean-up or reject; protected pure-deletions remain skip + audit.

No open questions remain blocking implementation.

---

## 18. Parking lot

- Transcript-backed curation.
- Cross-project pattern detection.
- Curator quality metrics from `verify_memory` outcomes.
- Automatic “memory budget” targets per category/project.
- Recommendations to improve session checkpoint quality.
- Session lifecycle automation. This has its own research/spec and should not be folded into this feature.
