# Autonomous Build Notes — 2026-05-23

**Task:** Implement `docs/specs/implementation-plan.md` (autonomous mode).
**Driver:** Guybrush (claude-code, autonomous build)

Increments shipped this day, each its own PR:

1. `feat/naming-contract-foundation` — Stage 1.2 resolver core (merged, PR #70).
2. `feat/naming-contract-mcp-wiring` — Stage 1.4 MCP soft-mode wiring (merged, PR #71).
3. `feat/naming-contract-cli-identity` — Stage 1.4 CLI caller canonicalisation (merged, PR #72).
4. `feat/naming-contract-audit` — Stage 1.1 baseline audit dry-run (merged, PR #73).
5. `feat/naming-contract-dashboard-actor` — Stage 1.4 dashboard-admin actor (merged, PR #74).
6. `feat/naming-contract-backfill` — Stage 4.1 Phase-3 caller-id backfill (merged, PR #75).
7. `feat/naming-contract-live-aliases` → pivoted to `soft-mode missing-identity warning`
   (Stage 1.4 observability, merged, PR #76).
8. `feat/naming-contract-actor-kind` — Stage 1.3 `actor_kind` projection column (merged, PR #77).
9. `feat/naming-contract-dashboard-grouping` — Stage 1.4 §7.5 agent-filter grouping (merged, PR #78).
10. `feat/naming-contract-sessions-admin-actor-test` — Stage 1.4 sessions-router actor coverage (merged, PR #79).
11. `feat/curator-note-column` — Stage 2.1 (partial) `curator_note` memory column (merged, PR #80).
12. `feat/curation-tables` — Stage 2.1 (finish) curation runs/operations tables (merged, PR #81).
13. `feat/curator-fingerprint` — Stage 2.2 (partial) content fingerprint + resurrection match (merged, PR #82).
14. `feat/curator-redaction` — Stage 2.2 (partial) secret redaction (merged, PR #83).
15. `chore/sanitize-redaction-test-fixtures` — synthetic fixtures + `.gitguardian.yaml` (merged, PR #84).
16. `feat/admin-secret-crypto` — Stage 2.3-prep AES-256-GCM secret-store crypto (this PR).

**Stage 1 complete** (#70–#79). **Stage 2.1 complete** (#80–#81). **Stage 2.2 primitives**
(fingerprint #82, redaction #83) complete. Stage 2.3 underway (Jim chose: build the admin
secret-store; LLM client = OpenAI-compatible).

> **GitGuardian:** the redaction-test fixtures (synthetic, secret-shaped) trip the GitGuardian
> GitHub App. A scoped `.gitguardian.yaml` was added but the App is dashboard-configured and
> didn't honour the repo file — **needs a one-time false-positive resolution in the GG dashboard
> (Jim)**. GG is advisory/non-blocking; all other checks pass.

---

## Increment 16 — Stage 2.3-prep AES-256-GCM secret-store crypto

The encryption-at-rest primitive for the admin secret-store (Jim's decision: build it; spec §7.1
stores the LLM token via admin secret-storage, never plaintext). New `secret-crypto.ts`:
`encryptSecret(plaintext, key)` / `decryptSecret(payload, key)` (AES-256-GCM — confidentiality +
integrity; the auth tag rejects tampering and wrong keys) and `resolveSecretKey(raw)` (parses a
64-char hex or base64 32-byte master key from the operator). Fresh random 12-byte IV per
encryption; self-describing versioned payload `gcm1.<iv>.<tag>.<ct>` (base64; no `.` collision).
Key is injected (read from `LIBRARIAN_SECRET_KEY` by callers), keeping the crypto pure/testable.
9 tests: round-trip (incl. unicode/empty/5 KB), IV-uniqueness, tamper rejection, wrong-key
rejection, key parsing (hex/base64/missing/wrong-length).

**Context found:** no admin secret-store or settings table exists today — all config/secrets are
env vars. So the broader secret-store is: this crypto (done) → a `settings`/secret table + store
accessors (next) → curator LLM config schema (env `LIBRARIAN_SECRET_KEY` master key + provider/
endpoint/token/model) → OpenAI-compatible LLM client → prompt/validate/apply (§10.4/§10.5/§11) →
scheduler/worker (§12/§14) → admin cockpit (§7.1/§13).

---

## Increment 13 — Stage 2.2 (partial) content fingerprint + resurrection match

Pure primitives behind the curator's resurrection-prevention pre-pass (memory-curator §9.1 /
§10.3), in a new `curator-fingerprint.ts`:

- `normalizeForFingerprint(text)` — NFKC, lowercased, punctuation-stripped, whitespace-collapsed.
- `contentFingerprint(title, body)` — sha256 of the normalised title+body (joined with `\n`, which
  the normaliser never emits, so the boundary can't collide: `("ab","")` ≠ `("a","b")`).
- `normalizedTitle(title)` — a tombstone also matches on title alone.
- `matchesTombstone(candidate, tombstones)` — returns the first tombstone a candidate would
  resurrect (by fingerprint OR normalised title), else null.

No store/LLM dependency and no schema change — fully unit-tested (10 tests). Server-only, so it
uses `node:crypto` (not exposed on a client subpath).

Remaining Stage 2.2: **evidence gathering** — slice-scoped (`common_global` / `common_project` /
per-`agent_private`) bundling from the store, building tombstone refs from archived memories, with
the **secret/cross-slice redaction** the spec calls a "non-negotiable privacy boundary" (§9). That
privacy-critical piece is its own focused increment.

## Increment 14 — Stage 2.2 (partial) secret redaction

The privacy boundary itself (memory-curator §9): `redactSecrets(text)` scrubs secret-looking
material from evidence **before** prompt construction, in a new `curator-redaction.ts`. A
conservative **known-format + assignment** redactor — PEM private keys, provider token shapes
(`sk-`/`sk-ant-`, `ghp_…`, `AKIA…`, `xox…`, `AIza…`), JWTs, `Bearer …`, and `key = secret`
assignments (value redacted, key kept for context) — returning `{ redacted, count }`.

Deliberate design choices (documented in-module): **no generic high-entropy detection** — it
would shred git SHAs / UUIDs / content hashes and degrade the curator's evidence; entropy/semantic
detection is a v2 concern. Rule order runs the assignment rule first so an assigned secret is one
unit and its marker isn't re-matched (no double-count). All regexes linear (no ReDoS). 8 tests
incl. a negative (git SHA + UUID stay intact). No store/LLM dependency.

**Security review (security-auditor sub-agent) hardened it before merge.** It empirically found a
**Critical** (the assignment rule failed *fully open* on quoted-with-spaces values — a real leak)
and Important gaps. Fixes: the assignment value now handles single/double-quoted values in full
(function replacer reconstructs the quotes); added **Stripe** (`sk_live_`…), **basic-auth URL /
connection-string passwords** (`scheme://user:pass@host`), and **GitLab/npm/PyPI** rules; markers
are now skipped by every rule so re-running is a true no-op (`count` = 0); added the `credentials`/
`account_key` keywords and a bounded Slack rule. Known v1 gap (documented): an *unquoted* secret
value with spaces is redacted only to the first space. 13 tests.

Remaining Stage 2.2: **evidence gathering** — slice-scoped store bundling that *uses*
`redactSecrets` + the fingerprint primitives to build the bounded, redacted, tombstone-bearing
evidence bundle (§9 caps/ordering). That's the integration increment.

### ⛔ Stage 2.3 is a decision gate (needs Jim)

The LLM pass (§10.4) needs operator decisions before it can be built: **provider/endpoint, model,
and how the API token is supplied** (admin secret-store), plus the `default_auto_apply` posture
(spec defaults `safe_only`) and confidence threshold. I'll surface these explicitly when 2.2 lands.

---

## Increment 12 — Stage 2.1 (finish) curation runs/operations tables

Completes the curator data model (memory-curator spec §8). Adds `memory_curation_runs` +
`memory_curation_operations` to the schema and a new `curation-store.ts` create/read data-access
layer (`createCurationRun`, `getCurationRun`, `listCurationRuns`, `recordCurationOperation`,
`getCurationOperations`), composed into `LibrarianStore`. JSON array/payload columns round-trip
via stringify/parse. `PROJECTION_SCHEMA_VERSION` bumped 8 → 9; snapshot refreshed.

Like `sessions`, these tables are **SQLite-authoritative** (they record *why* the curator acted —
not a projection of the memory ledger), so they are deliberately **absent from
`dropProjectionTables`** and survive schema-version bumps; the bump just `CREATE`s them on
existing installs. A rebuild-survival test pins this.

Deferred to the worker (Workstream 2.4), where the transitions are actually exercised:
`updateCurationRun` (status `pending → running → completed/failed`, usage accounting, timestamps)
and operation status updates (`applied_at`/`error`). This increment is the create/read foundation.

---

## Increment 11 — Stage 2.1 (partial) `curator_note` memory column

First slice of the curator data model (memory-curator spec §8 — explicitly "the **only** change
to the memory store"). Adds a nullable JSON `curator_note` field to the memory record carrying
curator provenance + the `supersedes` reference that makes a protected-correction proposal
actionable. It flows to a `curator_note TEXT` column via the event-sourced path (memory record →
`events.jsonl` → `reduceMemoryLog` → projection, parsed back in `rowToMemory`), survives a
rebuild, and defaults to null. `PROJECTION_SCHEMA_VERSION` bumped 7 → 8; snapshot refreshed.
`CuratorNoteSchema`/`CuratorNote` added to `schemas/memory.ts` and declared on `MemorySchema`.

**Security (caught in review — fixed before merge):** `curator_note` is set **only** via
`createMemory`'s trusted `options` channel (used by the future apply layer / proposal path),
never from the free-form `input` record. The first cut read it from `normalizeMemoryInput`, which
would have let an MCP agent smuggle a forged `supersedes` through `remember`/`propose_memory`
(their `inputSchema` is advertised, not parse-enforced, and `scopeAgentArgs` shallow-copies all
keys). Now `normalizeMemoryInput` ignores it entirely. Also omitted from `MemoryPatchSchema` so
the wire contract matches `cleanPatch`'s allowlist (curator_note is not patchable). Two negative
tests pin it: core (`createMemory` ignores `input.curator_note`) and MCP (`remember` can't set it).

Remaining Stage 2.1: the `memory_curation_runs` + `memory_curation_operations` tables (a separate
SQLite-authoritative store with their own accessors) — next increment.

---

## Increment 9 — Stage 1.4 §7.5 dashboard agent-filter grouping

The user-facing payoff of the canonicalisation/`actor_kind` work. The memories Agent filter
dropdown (`components/memories/filters.tsx`) now partitions its data-driven options (§7.5):
real agents at the top level, reserved/system actors (`system-*`/`dashboard-*`/`cli`) under a
"System actors" `<optgroup>`, and the legacy `unknown-agent` sentinel called out under a
"Legacy" group as "unknown-agent (legacy)" — while its filter **value** stays `unknown-agent`
so filtering is unaffected. Canonical ids were already guaranteed by canonical storage, so no
backend change was needed.

Reserved classification reuses core's `isReservedId` directly. To avoid pulling core's
`node:sqlite` store into the client bundle (the barrel `@librarian/core` re-exports it), I added
a new **client-safe subpath export** `@librarian/core/caller-identity` (the module is pure — no
I/O) and import from there. Verified with a real `next build`: the client bundle compiles, no
node builtins leak. (Review caught that an earlier local-mirror copy was avoidable; this is the
proper drift-free fix.)

Remaining §7.5 (deferred): the analytics/aggregates views could surface the same grouping. The
**sessions** dashboard has no agent-filter dropdown (agent shows as a per-row pill), so there's
nothing to group there. Left as a focused follow-up on the memories surface.

---

## Increment 8 — Stage 1.3 `actor_kind` projection column

Spec §6 / §14 open-question #3 (resolved): persist an explicit `actor_kind`
(`agent`/`admin`/`system`/`cli`) so the dashboard can group/filter by actor kind in SQL and
the audit ledger carries the kind as metadata. Added `actor_kind TEXT` to the **`memories`** and
**`events`** projection tables, derived from each row's `agent_id` via the resolver's existing
`actorKind()` during the single `rebuildMemoryIndex` insert path. `PROJECTION_SCHEMA_VERSION`
bumped 6 → 7; `test/schema-snapshot.json` refreshed. The bump repopulates both tables on next
boot (memory side is JSONL-canonical, so the rebuild fills the new column for existing installs).

**Scope decision — sessions deferred deliberately.** `sessions.actor_kind` was left out of this
increment: a session carries *two* agent ids (`created_by_agent_id` / `current_agent_id`) and
multiple write paths (insert + in-place update), so it needs a modeling decision (which id's
kind, and keeping it in sync on reassignment) that shouldn't be rushed into a schema migration.

- [ ] **Follow-up: `sessions.actor_kind`.** Decide created_by-vs-current semantics, add the
  column + populate in `upsertSession`/`updateSessionRow`, keep it in sync on agent reassignment.
- [ ] **Note:** `actor_kind` is *derivable* from `agent_id` (it's denormalised for SQL
  grouping/filtering + audit metadata per §6). The dashboard §7.5 grouping work can now
  `GROUP BY actor_kind` instead of deriving in JS.

---

## Increment 7 — Stage 1.4 soft-mode missing-identity warning log

**Pivot note:** this slot was going to be the live `bede → guybrush` alias config, but
investigation showed that wiring a live alias at the MCP boundary moves ~20+ load-bearing
`bede` assertions in `sessions.mcp.test.ts` (the churn PR #71 deliberately deferred) for
**low current value** — there is no live `bede` traffic (data is all `guybrush`/`claude`/…),
and the Phase-3 backfill already covers stored `bede`. So a live alias would be defensive-only
dead code today. Pivoted to a higher-value, lower-blast-radius item instead.

The missing-identity warning instruments the exact signal Stage 4 hard-enforcement is gated on
(§9: "no new `unknown-agent` rows for 7 consecutive days"). `callTool` in `dispatch.ts` — the
single point that knows the tool name, args, and context — now logs a `logger.warn` whenever an
**agent** call carries no identity (no token-bound id and no request-body `agent_id`), i.e. when
the resolver will fall back to `unknown-agent`. Admin calls are exempt (they carry no agent
identity by design). The warning binds `tool`, `actor_id`, and (when present) `harness` /
`source_ref`. No change to resolution behaviour — purely additive observability.

`logger` / `createLogger` are now exported from `@librarian/mcp-server` (so tests can spy and
downstream embedders can reuse the configured pino instance).

- [ ] **Live `bede → guybrush` alias still deferred.** When Hermes/integration traffic or test
  fixtures are migrated to `guybrush`, wire the live alias map into `scopeAgentArgs` and rename
  the `bede` test fixtures in one dedicated PR. The backfill map already lists it.
- [ ] **Log volume / gate metric (review note).** The warning is per-call at `warn` level —
  intentional granularity for the 7-day observation window, but if unattributed traffic is
  noisy, consider a sampled/aggregated counter as the actual gate metric before Stage 4.
- [ ] **Predicate drift (review note).** The missing-identity predicate in `dispatch.ts` mirrors
  the resolver's fallback condition by hand (it's the only layer with the tool name). A cleaner
  long-term home is the resolver itself returning a `fell_back` flag — fold in when wiring hard mode.

---

## Increment 6 — Stage 4.1 Phase-3 caller-id backfill

The write step that pairs with Increment 4's read-only audit. `backfillCallerIds(store, opts)`
in `@librarian/core` (+ `scripts/backfill-agent-ids.mjs`, `pnpm backfill:agent-ids`) rewrites
stored caller ids to canonical form: normalises every non-empty id, applies a **one-time
backfill alias map**, never touches `unknown-agent`, is a no-op in dry-run, and is idempotent.

Each subsystem is reattributed via its own **durable** path (this is the crux of the design):

- **Memories** are JSONL-canonical (`events.jsonl` is the source; SQLite is a rebuilt
  projection), so reattribution appends a `memory.bulk_updated` event via `bulkUpdateMemory`.
  A direct SQL UPDATE would be clobbered on the next projection rebuild.
- **Sessions** are SQLite-authoritative since R3 (the `sessions` table survives schema bumps;
  a *warm* rebuild refreshes only the timeline projection — verified in `projection.ts`
  `rebuildSessionIndex`), so reattribution is a direct, durable UPDATE on `sessions`
  (`created_by_agent_id` / `current_agent_id`) and `session_state_changes.actor_agent_id`.
  Caveat: a *cold* rebuild (empty `sessions` table, e.g. after deleting `librarian.sqlite`)
  replays the legacy JSONL ledger and would reintroduce `claude`; the backfill is idempotent,
  so re-running after a from-scratch rebuild is the intended recovery (standard for migrations).

Dry-run against the repo's `./data` confirmed: `system → system-migration` (2 memories),
`claude → claude-code` (8 sessions), `codex`/`opencode`/`pi` left untouched.

Also fixed the CLI `seed` to write `system-migration` instead of a bare `system`, so it stops
reintroducing the legacy id (`packages/cli/src/runtime.ts`).

### Backfill decisions (RESOLVED with Jim, 2026-05-23)

- [x] **`system` → `system-migration`.** Confirmed. The seed's bootstrap memories are placed by
  a system process, so `system-migration` (§6's designated backfill actor) is the right id; the
  seed now writes it directly. No spec conflict.
- [x] **`claude` → `claude-code`: backfill the rows, but add NO live alias.** This needs care:
  §8 and §14 (open-question #1) **explicitly resolved against** an alias, keeping `claude`
  distinct from a *future* `claude` surface. Surfaced that conflict to Jim. Resolution: the
  existing stored `claude` rows are known *historical Claude Code* data, so the one-time
  backfill rewrites them to `claude-code`, **but** the resolver's live alias map stays empty
  for `claude` — honouring the spec's "keep `claude` free going forward". The backfill alias
  map (`scripts/backfill-agent-ids.mjs`) is therefore deliberately SEPARATE from the live
  resolver alias map. No spec change required.

### Also added (spec-mandated, surfaced in review)

The backfill alias map also includes `bede → guybrush` and `guybrush-hermes → guybrush` —
already-approved mappings in spec §8 (Hermes Bede is the same actor as Guybrush) and the §9
`backfill_aliases` example, not new decisions. They're no-ops on the current `./data` (no such
ids present) but make the canonical backfill tool spec-complete. The **live** resolver alias
`bede → guybrush` is still deferred to a separate alias-config increment (the MCP boundary
passes no alias map today).

### Note on rewriting `session_state_changes.actor_agent_id`

The backfill also rewrites the historical actor on past state transitions (`claude` →
`claude-code`). This is the *same* actor under its canonical name (not falsifying history), and
keeps the state-change audit consistent with the reattributed `sessions` rows. Flagged here in
case you'd prefer audit rows frozen at their original (pre-canonical) spelling.

---

## Increment 5 — Stage 1.4 dashboard admin actor

Both tRPC routers attributed admin mutations to a bare `"dashboard"` actor; spec §6/§7.5
mandate the reserved `dashboard-admin`. Now sourced from core's
`SYSTEM_ACTOR_IDS.dashboardAdmin` (single source of truth) in `trpc/memories.ts` and
`trpc/sessions.ts`. New tRPC test asserts an admin archive with no `agent_id` records the
`dashboard-admin` actor in the ledger.

Remaining §7.5 (deferred): the dashboard **UI** changes — agent-filter dropdowns showing
canonical ids only, `unknown-agent` marked legacy, system actors grouped — are a frontend
task for a later increment.

- [x] **Fast-follow (done, Increment 10):** a mirror test for the sessions router's
  `dashboard-admin` fallback. Asserts against the `session_state_changes` ledger (read directly
  from the store, since the actor is recorded as a state change, not a timeline event). It
  characterises the existing shared-constant behaviour — passed on first write.

---

## Increment 4 — Stage 1.1 baseline audit (Phase 0 dry-run)

Pure `auditCallerIds(rawIds)` in `@librarian/core` + a read-only
`scripts/audit-agent-ids.mjs` (`pnpm audit:agent-ids`). Runs `normaliseCallerId` over the
existing stored ids (memories.agent_id, sessions.created_by_agent_id / current_agent_id),
groups them by canonical form, flags collapse groups and unnormalisable ids — **changes
nothing** (no aliases applied; alias decisions wait for human review per §10).

### Audit findings against the repo's `./data` (for the eventual backfill — Workstream 1.3/Phase 3)

Ran `pnpm audit:agent-ids`: **5 distinct ids — `claude`, `codex`, `opencode`, `pi`,
`system` — all already canonical, no collapse groups, none invalid.** Two points to decide
before the Phase-3 backfill:

- [x] **`claude` vs `claude-code`.** RESOLVED in Increment 6: backfill the stored rows to
  `claude-code`, but add **no live alias** (the spec keeps `claude` distinct going forward).
- [x] **`system` as an agent_id.** RESOLVED in Increment 6: backfill to `system-migration` and
  fix the CLI seed to write it directly. See Increment 6 for the full rationale.

---

## Increment 3 — Stage 1.4 CLI caller canonicalisation

The CLI already had `callerAgent` (`--agent` / `LIBRARIAN_AGENT_ID` / default `cli`), so
§7.3's flag contract existed; the gap was **canonicalisation** — `--agent "Guybrush"` stored
`Guybrush`, diverging from the MCP boundary. `callerAgent` now routes through
`normaliseCallerId`, so all CLI attribution (every command funnels through it) is canonical.

- The CLI is a trusted local boundary (no token), so plain `normaliseCallerId` is used — not
  the role-gating `resolveCaller`. That keeps `cli` (a reserved id) valid as the default
  operator actor, per §4.4/§7.3.
- A malformed `--agent "!!!"` throws → surfaces as a clean `Error: …` (exit 1) via the
  runtime try/catch.
- Existing `--agent bede` / `cli` tests are unaffected (they normalise to themselves).

---

## Increment 2 — Stage 1.4 MCP surface wiring (soft mode)

Routes agent identity through `resolveCaller` at the **single MCP chokepoint**
(`scopeAgentArgs` in `packages/mcp-server/src/mcp/visibility.ts`) — every agent-facing
tool already funnels through it, matching the spec's "resolve once at dispatch/tool-entry"
(§7.2). Soft-migration mode, so missing identity is unchanged.

Behaviour now:

- **Normalisation** — a supplied `agent_id` is canonicalised before storage
  (`Guybrush (Hermes)` → `guybrush-hermes`).
- **No impersonation** — a mapped token + a *conflicting* request-body `agent_id` is now
  **rejected** (§5.3/§7.2) instead of silently overwritten. This intentionally changes the
  old "MCP start_session refuses to honour a caller-supplied agent_id" test, which encoded
  the silent-overwrite behaviour — it now asserts rejection (a stronger guarantee).
- **Reserved gating** — an ordinary agent cannot claim `system-*`/`dashboard-*`/`cli`.
- **Soft fallback** — a shared token with no id still resolves to `unknown-agent`.
- **Admin** path unchanged (`admin: true`, no `agent_id` pinning).

Also: `ResolveCallerInput`'s three id fields now explicitly accept `| undefined` so trust
boundaries can pass optional ids without conditional-spread gymnastics under
`exactOptionalPropertyTypes`.

**Deferred from 1.4 (next increments):** alias-map application (would remap `bede →
guybrush` and is a Phase-3 backfill concern — applying it live now changes attribution that
several MCP tests assert literally), CLI `--agent`/`LIBRARIAN_AGENT_ID`, dashboard/tRPC
dropdowns, and a soft-mode warning log for missing identity. Plus 1.1 audit + 1.3 store
`actor_kind` column.

---

## Scope decision for this run

The implementation plan spans **four stages** (naming foundation → curator → harness
integrations across 5 harnesses → naming hard-enforcement) — realistically weeks of work
and far more than one safe, reviewable PR.

Per the plan's own sequencing principle ("the naming contract … *brackets* them. Its
foundation must land first"), this run delivers **Stage 1, Workstream 1.2 — the resolver
core**: the pure, fully-tested, zero-regression-risk foundation that unblocks everything
else. It adds new code in `@librarian/core` and wires nothing yet, so no existing
behaviour changes.

### Delivered this run

- `normaliseCallerId(raw)` — §4.2 normalisation algorithm.
- Alias resolution with loop/recursion rejection — §4.4.
- Reserved-namespace constants + enforcement (`system-*`, `dashboard-*`, `cli`) — §4.4.
- System actor ids — §6.
- `resolveCaller(input): ResolvedCaller` — §7.1 (precedence, normalise, alias, validate).
- Full unit-test coverage per §11 (unit-test list).

### Deferred to follow-up increments (with rationale)

These were intentionally **not** done in this PR to keep it focused and low-risk:

1. **Workstream 1.1 — Baseline audit script.** Read-only dry-run over existing stored ids.
   Easy follow-up; uses the resolver shipped here.
2. **Workstream 1.3 — Store attribution.** Persisting canonical ids + `actor_kind`
   column. Touches the store schema/projection; deserves its own migration-aware PR.
3. **Workstream 1.4 — Surface wiring (soft mode).** MCP `scopeAgentArgs`
   (`packages/mcp-server/src/mcp/visibility.ts:25` currently pins `agent_id` from auth
   context), CLI `--agent`/`LIBRARIAN_AGENT_ID`, dashboard dropdowns. This rewires the
   live identity path and several integration tests assert the current `unknown-agent`
   behaviour — higher risk, wants a dedicated PR + soft-warning rollout.
4. **Stages 2–4** (curator, harness integrations, hard enforcement) — sequenced after
   Stage 1 lands per the plan.

---

## Code review outcome

A `code-reviewer` sub-agent reviewed the resolver across all five axes and probed 11+
escalation/bypass vectors against the security boundary. Verdict: **ship-with-fixes** —
**zero Critical, zero Important**; all findings Suggestion-tier. Confirmed: agent→reserved
escalation is blocked via raw input, alias target, allowlist, and token-bound paths;
token-binding can't be bypassed (injected mismatch rejected too); no ReDoS in the
normalisation regexes (all linear).

Suggestions actioned this run:

- Added a cheap pre-normalisation length guard (`MAX_RAW_LENGTH = 1024`) so megabyte-scale
  input is rejected before the Unicode/regex passes — matters once this is wired to the
  attacker-facing MCP/CLI boundary.
- Clarified the alias single-hop/chain-rejection comment.
- Added tests: injected-vs-token mismatch, invalid token-bound id, raw-length guard,
  `isReservedId` coverage, `dashboard-*` (non-`dashboard-admin`) classification. (150 tests.)

## Points for Jim to consider

- [ ] **`ResolvedCaller.alias_applied` semantics.** The spec (§7.1) only declares the field;
  this implementation defines it as *the pre-alias normalised id* (set only when an alias
  actually fired). When Workstream 1.3 persists it to the audit trail, confirm the store
  consumer agrees on that meaning (pre-alias source vs. the literal alias key).
- [ ] **`cli` reserved-id role gating.** The spec's role enum is `agent|admin|system` (no
  `cli` role), but `cli` is a reserved id. I gated it as "not usable by `role: "agent"`"
  (so admin/system/local-operator paths may use it). Confirm that matches your intent for
  §7.3 manual CLI calls, or whether `cli` should get a first-class role.
- [ ] **Two `DEFAULT_AGENT_ID` definitions.** `unknown-agent` is declared in *both*
  `packages/core/src/constants.ts` and `packages/core/src/schemas/common.ts:173`
  (same value, exported via different paths). Pre-existing; harmless but worth de-duping.
