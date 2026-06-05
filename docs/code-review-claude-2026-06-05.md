# The Librarian — whole-codebase code review (2026-06-05)

**Reviewed:** `main` @ `d985df3` (post-merge of #309/#310/#311). ~21.5k LOC of TypeScript across `packages/core`, `packages/mcp-server`, `packages/cli`, `packages/consolidator-eval`, `apps/dashboard`, and `scripts/` + ops config.

**Method.** Nine parallel review agents each owned a slice (store/vault, recall+index+git, consolidator-intake, curator-grooming, security/backup/auth/crypto, core data-model, mcp-server, dashboard, cli/scripts/build) under a shared five-axis + dead-code/vestigial/waste/complexity brief and a calibrated 1–100 severity rubric. I (lead) deduplicated across slices, normalized severities, grouped the comment-drift cluster, and **independently verified the three highest-severity security findings** — one of which I downgraded (see ⚠️ below).

**How to read severities & confidence.** Severity 1–100: 80+ Critical, 60–79 High, 40–59 Medium, 20–39 Low, <20 Nit. "Fix effort" is **AI-agent time**, not human. Every item carries the reviewing agent's **confidence**. I re-verified only the top 3 security items firsthand; **everything else is a strong lead, not a confirmed fact** — treat `med`/`low` confidence items as "confirm before acting." None of these block current operation; this is a health/debt review.

**Cross-reference:** items already tracked in [`docs/tech-debt.md`](docs/tech-debt.md) or [`docs/TODO.md`](docs/TODO.md) are tagged `[tracked]`.

---

## Prioritized summary (most → least important)

| # | Severity | Effort | Area | Finding |
|---|---:|---|---|---|
| 1 | **85** | 1–3h | dashboard | tRPC proxy serves `auth.config` (AUTH_SECRET + OAuth secrets) **unauthenticated** in the `open` enforcement window |
| 2 | **78** | 15–60m | security | `LIBRARIAN_VAULT_PATH` overlapping the data dir pushes `secret.key`/`admin.token` to the backup remote |
| 3 | **78** | 15m | security | Curator/consolidator LLM client omits `redirect:"error"` — bearer token can leak cross-origin on a 3xx |
| 4 | **72** | 1–3h | dashboard | Admin-mutating server actions have no session check in the `open` window (owner-credential land-grab) |
| 5 | **72** | 15–60m | security | `runGitWithToken` doesn't disable inherited git `credential.helper` — token can persist to disk |
| 6 | **72** | 1–3h | consolidator | `target_id ∈ EVIDENCE` is promised in the prompt but never enforced in code (injection scoping bypass) |
| 7 | **70** | 15–60m | cli/scripts | `audit:agent-ids` script calls removed `distinctSessionValues` — crashes on every run |
| 8 | **68** | 1–3h | consolidator | `archiveMemory` has no protected-category gate — can auto-archive identity/relationship memories |
| 9 | **68** | 15–60m | curator | Idempotency hash omits the apply policy — flipping auto-apply can be silently ignored |
| 10 | **68** | 1–3h | store/vault | `relinkVault` throws on any real vault **and** has zero production callers (F12 link-integrity is dead) |
| 11 | **66** | 1–3h | consolidator | `redactSecrets` misses JSON-quoted secret assignments (`"api_key":"…"`) |
| 12 | **64** | 15–60m | store/vault | `readAllMemories` / handoff list throw on one corrupt `.md` — takes down every list/search verb |
| 13 | **60** | 15–60m | curator | Config read-path doesn't re-validate interval/confidence — a `0` interval causes runaway LLM runs |
| 14 | **60** | 15–60m | consolidator | Raw submission text persisted to the vault **unredacted** on `create_new`/`propose` |
| 15 | **60** | 15–60m | cli/ops | Dashboard container healthcheck probes the heavy `/health` SSR page, not `/api/health` liveness |
| 16 | **60** | 15–60m | security | `clearSetupLinks` silently no-ops without `deleteSetting` — prior setup links stay live |
| 17 | **58** | 1–3h | recall/git | Async `createGitOps` (simple-git) is dead in prod yet drags the whole `simple-git` dependency |
| 18 | **52** | 15–60m | recall | `cosineSimilarity` recomputes the query norm for every doc on each recall (~3× the needed work) |
| 19 | **52** | 15–60m | security | Backup webhook URL allows internal targets (SSRF) and permits cleartext `http://` |
| 20 | **48** | 15–60m | dashboard | Proposal approve/reject/archive **silently swallow** action failures — looks like success |
| 21 | **48** | 3–8h | recall | Per-sweep full index rebuild (keyword+graph+vector) re-reads the whole corpus per applied item |
| 22 | **48** | 15–60m | deps | `next` bundles vulnerable `postcss@8.4.31` (GHSA-qx2v-qp2m-jg93); no `pnpm audit` CI gate `[tracked]` |
| 23 | **46** | 1–3h | security | Restore-clone validation accepts any repo containing one Librarian-shaped dir |
| 24 | **45** | 15–60m | cli/eval | `consolidator-eval --gate` without `--baseline` gates nothing and exits 0 (silent green) |
| 25 | **45** | ⚠️ re-scored from 86 — backup repo unvalidated on env/read path (defense-in-depth, **not** exfil) `[tracked]` |
| 26 | **45** | 15m | consolidator | `private_key`/`signing_key`/`encryption_key` assignments not in the redaction keyword list |
| 27 | **44** | 1–3h | security | `check-no-secrets-in-vault` scans only the default-layout working tree, never git history `[tracked]` |
| 28 | **42** | 15–60m | dashboard | Five `ui-v2` design-system components are dead (kept alive only by their smoke test) |
| 29 | **42** | 15m | core | `PROTECTED_CATEGORY_STRINGS` is a fully dead export |
| 30 | **42** | 15–60m | security | Sidecar settings/conv-state/curation writes are non-atomic — a crash mid-write corrupts `settings.json` |
| 31 | **42** | 1–3h | curator | `dry_run` vs `apply` mode is vestigial — the worker only ever creates `apply` runs |
| 32 | **40** | 1–3h | store/vault | Five `*-types.ts`/`*-store.ts` shim pairs are pointless post-SQLite indirection |
| 33 | **40** | 15m | core | Duplicate `DEFAULT_AGENT_ID` (the `schemas/common.ts` copy is dead) |
| 34 | **40** | 15–60m | cli | Top-level CLI verbs (`rebuild`/`seed`/`backup`/`export`) aren't in try/catch — raw stack trace on error |
| 35 | **40** | 1–3h | curator | Per-tick full-vault reads: each due slice re-reads+re-parses the whole corpus 3× |
| 36 | **40** | 1–3h | recall/git | The GIT_ASKPASS token-scrubbing security code has **zero** test coverage |
| 37 | **38** | 15–60m | store/vault | `Memory` type still carries D16-retired `category`/`visibility`/`scope` with no readers |
| 38 | **38** | 15m | mcp-server | `isSessionVisible` + `SessionLike` is fully dead (retired session subsystem) |
| 39 | **36** | 1–3h | curator/consolidator | Duplicated `ApplyStore` interface + redacted-`curator_note` builder across both clusters |
| 40 | **35** | 1–3h | cross-cutting | **Cluster:** ~14 vestigial SQLite/sessions comments & stale config (see §Cluster) |
| 41 | **34** | 1–3h | core/mcp | Retire conversation-state `session_id` end-to-end (schema + store + tool still plumb a dropped field) |
| 42 | **34** | 1–3h | curator | `correctedMemory` rebuilds protected-update proposals from legacy fields markdown no longer populates |
| 43 | **34** | 1–3h | recall | Edited memories orphan vectors in the unbounded embedding cache (heap creep on long-lived grooming) |
| 44 | **33** | 1–3h | store/vault | `InternalLibrarianStore` is a no-op alias of `LibrarianStore` (two names, ~10 import sites) |
| 45 | **32** | 15–60m | cli/eval | `Gate: FAIL` prints to real stdout during a **passing** test — looks like a failure |
| 46 | **30** | 15–60m | mcp-server | Non-null assertions on store calls that actually `throw` (misleading `Memory\|null` contract) |
| 47 | **30** | 15m | security | `resolveSecretKey` only rejects all-identical-byte keys, not other low-entropy placeholders |
| 48 | **30** | 15–60m | store/vault | `coerceDates` duplicated verbatim 3×; YAML scalar-escaper duplicated 2× |
| 49 | **30** | 15–60m | ops | `pull-and-restart.sh` leaves the repo stashed/on `main` when a deploy healthcheck fails (no restore on error) |
| 50 | **28** | 15–60m | consolidator | `redactSecrets` runs each `/g` regex twice (count then replace) + a dead identical ternary |
| 51 | **28** | 15–60m | mcp-server | `recall` tool doesn't clamp `limit`; a negative value silently *drops* results |
| 52 | **28** | 15–60m | dashboard | `g`-prefix nav does a full-page reload instead of client routing |
| 53 | **28** | 1–3h | store/vault | memory/handoff serializers use `matter.stringify`, undercutting the "byte-stable double-quoted" contract |
| 54 | **28** | 15–60m | curator | Lock TTL hard-coded 60 min, decoupled from the configurable per-request timeout × slice count |
| 55 | **26** | 15–60m | dashboard | `SimpleMemoryList` shares one `useTransition` flag — any action disables all rows' buttons |
| 56 | **26** | 15–60m | consolidator | `CONSOLIDATOR_PROMPT_VERSION` exported but inert (no idempotency plumbing, unlike the curator's) |
| 57 | **26** | 15–60m | mcp-server | `memoryInputSchema` marks `agent_id` required, contradicting token-resolved identity |
| 58 | **26** | 15–60m | recall | `searchReferences` comment claims "no cache" — misleading; embeds *are* cached |
| 59 | **24** | 15–60m | consolidator | `stripCodeFence`/`summarizeIssues`/`isRecord` duplicated verbatim between the two parsers |
| 60 | **24** | 1–3h | mcp-server | Handoff input shape hand-maintained as JSON Schema **and** Zod (free to drift) |
| 61 | **24** | 15–60m | dashboard | `bulkUpdateMemoriesAction` forwards client `ids`/`patch` with no boundary validation |
| 62 | ≤22 | various | — | ~14 Low/Nit items (see §Low & Nit) |

**Rollup:** 0 of these are exploited-in-the-wild or block operation today. By tier: **~6 Critical/High-security**, **~10 High correctness/fail-soft**, the rest Medium/Low maintainability, dead-code, perf, and comment-drift. Rough total agent-time to clear the whole backlog: **~4–6 working days**; the top-10 alone is **~1–1.5 days** and removes the meaningful risk.

---

## Critical & High — full detail

### 1. [85 · security · 1–3h · confidence: high ✅ verified] Dashboard tRPC proxy serves `auth.config` secrets unauthenticated in the `open` window
**Location:** `apps/dashboard/app/api/trpc/[trpc]/route.ts:39-43,53-54` · `apps/dashboard/lib/auth-gate.ts:72-79` · `packages/mcp-server/src/trpc/auth.ts` · `packages/core/src/auth/auth-config.ts:103-110`
**Problem:** The proxy forwards any tRPC segment upstream and unconditionally injects `LIBRARIAN_ADMIN_TOKEN`. The session check runs only when `enforcement !== "open"` (line 40). `decideEnforcement` returns `"open"` whenever the store config is `enabled:false` and the legacy env flag is unset — the **default posture while an owner is configuring auth but before they click "enable"**, and on a fresh box. In that window, `GET /api/trpc/auth.config` is proxied with the admin token and returns `getAuthConfig`'s payload — the HKDF-derived `authSecret` (JWT signing key) plus any decrypted OAuth `clientSecret`s. The route's own comment (line 64) acknowledges this payload "carries AUTH_SECRET, decrypted OAuth secrets." `isSameOrigin` blocks browser CSRF but a **direct network client sends no `Sec-Fetch-Site` and is accepted** (line 20-21). Leaking `authSecret` lets an attacker forge a valid session JWT and defeat the gate once it's enabled. (Verified firsthand: the `!== "open"` shortcut and the admin-token injection are exactly as described.)
**Fix:** Add a procedure allow/deny-list in the proxy: reject `auth.*` (at minimum `auth.config`/`auth.verifyPassword`) and any admin-only procedure with 403 **regardless of enforcement state**; the browser only needs `health.*`, `memories.list/distinctValues/recall`, `handoffs.list/byId`. Alternatively drop the `!== "open"` shortcut so the admin token is never injected without a session. Add a regression test hitting `auth.config` in the open state.
**Caveat (fair view):** exploitability requires the box to be network-reachable during the configure-but-not-enabled window (or an authenticated/XSS context post-enable). The author clearly considered the enforce-case (see the line 31-38 comment); the gap is the open-window exposure of already-configured secrets and the absence of a per-procedure allowlist.

### 2. [78 · security · 15–60m · confidence: high] `LIBRARIAN_VAULT_PATH` overlap can push `secret.key`/`admin.token` to the backup remote
**Location:** `packages/core/src/store/corpus/vault.ts:41-47` · `packages/core/src/store/librarian-store.ts:184` · `packages/core/src/store/git/sync-git-ops.ts:100` (`git add -A`)
**Problem:** Secrets are kept out of the vault by **path convention only** (`secret.key`/`admin.token`/`settings.json` live in `<dataDir>`, the vault defaults to `<dataDir>/vault`). But `resolveVaultPath` honors `LIBRARIAN_VAULT_PATH`. If an operator points it at `<dataDir>` (or any ancestor of those files), the commit-per-write `git add -A` stages the cleartext `admin.token`, the AES-GCM `settings.json`, **and the `secret.key` that decrypts it**, and `pushVaultBackup` ships them to GitHub. Nothing rejects the overlap and no `.gitignore` excludes sibling credential files. The `check-no-secrets-in-vault` guard only exercises the default layout, so it never catches this.
**Fix:** At store construction, assert the resolved vault root neither contains nor is contained by the dataDir credential files; throw a teaching error otherwise. Belt-and-braces: write a `.gitignore` into the vault listing `secret.key`/`admin.token`/`settings.json`.
**Caveat:** misconfiguration-dependent (unusual env value), but the blast radius — the master key that decrypts everything, pushed to a remote — is catastrophic, and the guard is cheap.

### 3. [78 · security · 15m · confidence: high] LLM client omits `redirect:"error"` — bearer token can leak cross-origin
**Location:** `packages/core/src/curator-llm-client.ts:129`
**Problem:** This is the only network egress for both the curator and consolidator, and it sends `Authorization: Bearer ${token}`, but the fetch init has no `redirect` option → defaults to `"follow"`. AGENTS.md mandates `redirect:"error"` on every credentialed outbound call "so a 3xx can't leak the token cross-origin," and the repo's *token-less* backup webhook already sets it (`backup/run.ts:36`). A malicious/misconfigured `endpoint` returning a 3xx to an attacker host would replay the bearer token. No test asserts `redirect`.
**Fix:** Add `redirect: "error"` to the fetch init; add a test asserting it. (Highest value-to-effort ratio in the report.)

### 4. [72 · security · 1–3h · confidence: med] Admin-mutating server actions skip session checks in the `open` window
**Location:** `apps/dashboard/app/settings/auth/actions.ts:32-49` · `app/tokens/actions.ts:19-40` · `app/backups/actions.ts:35-70` · `app/curator/actions.ts:16-38` · `app/(memories)/actions.ts:106-124` · `middleware.ts:66`
**Problem:** Every mutation action calls `serverTRPC.*.mutate()` (admin token injected) with no `auth()` check of its own, relying on middleware — which returns `next()` for `open` (the same default window as #1). So an unauthenticated POST can drive `setPasswordAction`/`saveOAuthAction` (**land-grab the owner credential**), `createTokenAction` (mint an agent bearer token), `saveBackupConfigAction` (set a GitHub push token), or `disableAuthAction`. Only `auth.enable` is independently admin-token-gated; the credential-writing actions the `enable` guard was meant to protect are not.
**Fix:** Gate the credential-writing auth actions (`setPassword`, `saveOAuth`, `setOwner`) behind the admin token like `enable`, or require a session for all mutating actions and special-case only the genuine break-glass (`disable`). Test which actions are intentionally reachable pre-enforcement. (Same root cause as #1 — the "open" window trusts too much.)

### 5. [72 · security · 15–60m · confidence: med] `runGitWithToken` doesn't isolate git config — a `credential.helper` can persist the token
**Location:** `packages/core/src/store/git/sync-git-ops.ts:137-165`
**Problem:** The push/clone child inherits the host's system/global git config (only `GIT_ASKPASS`/`GIT_TERMINAL_PROMPT`/`LIBRARIAN_GIT_TOKEN` are added). If the environment has `credential.helper=store`/`osxkeychain`/`cache` configured (common on dev machines and some CI images), git can cache the askpass-supplied token to `~/.git-credentials` or the OS keychain — writing the bearer token to durable storage, undoing the careful URL/argv/`.git/config` scrubbing.
**Fix:** Pass `-c credential.helper=` (empty, disables inherited helpers) in the push/clone argv, and/or set `GIT_CONFIG_NOSYSTEM=1`.

### 6. [72 · security · 1–3h · confidence: high] Consolidator never enforces `target_id ∈ EVIDENCE` though the prompt says it does
**Location:** `packages/core/src/consolidator/judge-step.ts:51` (prompt) vs `consolidator/apply.ts:135,147,155` (only `getMemory` existence) · `consolidator/judge.ts` (route has no check)
**Problem:** The system prompt tells the model `target_id` MUST appear in the EVIDENCE and that "RULES [are] re-checked in code after you respond — a judgment that breaks one is discarded." No such check exists: `routeConsolidation` never receives evidence, and `applyConsolidationPlan` only verifies `getMemory(target_id)` is non-null (exists *anywhere in the store*, not in the navigate bundle). Memory content is untrusted; a prompt-injection that coaxes the model into `archive`/`supersede` on an out-of-band id bypasses the navigate scoping the safety story relies on. `mem_<uuid>` ids lower but don't eliminate the risk, and the unenforced-contract is itself a latent bug. The curator does this correctly (`curator-validate.ts` `referencedMemoryIds`).
**Fix:** Thread the evidence id set (candidates + ToC) into a pre-apply validation step and reject any `target_id` not in it before mutating; add a regression test with an in-store-but-out-of-evidence id.

### 7. [70 · dead-code/bug · 15–60m · confidence: high] `audit:agent-ids` script crashes on every run (calls removed `distinctSessionValues`)
**Location:** `scripts/audit-agent-ids.mjs:30-31` · `package.json:26`
**Problem:** The session subsystem was retired and `store.distinctSessionValues` no longer exists; the script still calls it. The reviewing agent ran it: `TypeError: store.distinctSessionValues is not a function`, immediate non-zero exit. It's wired into `package.json` as `audit:agent-ids`, so an operator following the agent-id audit runbook hits an instant crash.
**Fix:** Drop the two `distinctSessionValues` elements so it reads only `memories.agent_id` via `distinctValues` (and refresh the header comment), or delete the script + its `package.json` entry (its sibling `backfill-agent-ids.mjs` already audits memories only).

### 8. [68 · security/bug · 1–3h · confidence: med] `archiveMemory` has no protected-category gate
**Location:** `packages/core/src/consolidator/apply.ts:154-158` · `packages/core/src/store/markdown/markdown-memory-store.ts:238-247`
**Problem:** The curator routes protected (identity/relationship) archives to human review; the consolidator's `archive` auto-applies at confidence ≥ 0.95 straight through `store.archiveMemory`, which — unlike `updateMemory` (which checks `requires_approval`) — has **no** protected check. So one high-confidence (or injection-influenced) `archive` judgment can silently tombstone a protected identity memory with no proposal workflow. No test covers archiving a protected memory.
**Fix:** Gate `archiveMemory` on `requires_approval` like `updateMemory`, or have the consolidator route protected-target archives/supersedes to `propose` regardless of confidence. Add a regression test.

### 9. [68 · bug · 15–60m · confidence: high] Curator idempotency hash omits the apply policy — policy changes silently ignored
**Location:** `packages/core/src/curator-worker.ts:70-71,149-166` · `store/sidecar/curation-store.ts:134-141`
**Problem:** `computeInputHash` mixes slice + memory ids/updated/status + tombstones + prompt version + addendum, but **not** the apply policy. `runCuration` skips entirely when a prior completed apply-run matches the hash. So: a run completes with policy `off`; the operator flips `default_auto_apply` to `safe_only`; the next scheduled tick sees unchanged evidence → hash matches → the run is suppressed and the new policy never takes effect until a memory happens to change. The operator sees "no curation" with no signal why.
**Fix:** Add `policy:${level}:${confidenceThreshold}` to the hash `parts` (a policy change should permit a fresh run, exactly like a prompt-version bump).

### 10. [68 · bug/dead-code · 1–3h · confidence: high] `relinkVault` throws on any real vault and has zero production callers
**Location:** `packages/core/src/store/corpus/link-integrity.ts:19-29` · `corpus/index.ts:14` · `src/index.ts:217`
**Problem:** `relinkVault` iterates `vault.listMarkdown()` (every `.md`) and `readDocument`s each against `CorpusFrontmatterSchema`, which requires `category`/`created`/`updated`. But memory/handoff docs use different frontmatter (`created_at`/`updated_at`, no `category`), so on any vault containing one memory/handoff (every real install) it throws on the first such file. Its test only writes reference-shaped docs, so it never hits this. Worse, **it has no production caller** — the F12 "rename rewrites every wikilink" feature is built, exported, tested, and wired into nothing.
**Fix:** Either delete `relinkVault` + its export (unimplemented F12), or make it fail-soft per file (try/catch skip non-corpus docs, operate on raw body via `renameWikilinkTarget`) and add a test with a memory present.

### 11. [66 · security · 1–3h · confidence: high] `redactSecrets` misses JSON-quoted secret assignments
**Location:** `packages/core/src/curator-redaction.ts:46-58`
**Problem:** Empirically (per the reviewing agent) `"api_key": "verysecretvalue"` is **not** redacted while `api_key: value` is — the rule requires the keyword immediately followed by `(\s*[:=]\s*)`, and a JSON-quoted key puts a `"` between keyword and colon. JSON is one of the most common shapes for secrets pasted into agent memory (API dumps, config blobs), so this is a high-traffic miss for a redactor whose job is to scrub secrets before they reach the LLM and the vault.
**Fix:** Allow an optional quote between keyword and separator (`([\w-]*(?:KEYWORDS))["']?(\s*[:=]\s*)`); add JSON-quoted fixtures (assembled at runtime per the GitGuardian note).

### 12. [64 · bug · 15–60m · confidence: high] `readAllMemories`/handoff list throw on one corrupt `.md`, breaking every list/search verb
**Location:** `packages/core/src/store/markdown/markdown-memory-store.ts:302` · `markdown-handoff-store.ts:78-80`
**Problem:** `readAllMemories()` maps `parseMemoryDocument(readText(rel))` with no try/catch. One hand-edited/foreign/half-written file under `memories/` makes the parse throw, taking down `listAll`, `listMemories`, `searchMemories`, `detectRelated`, `getAggregates`, `startContext`, etc. The handoff store has the identical gap. This contradicts the store's own fail-soft posture — `scanIdToPath` and `buildCorpusIndex` both explicitly skip unparseable files (the vault is git-pushed + hand-editable).
**Fix:** Add a shared try-parse-and-skip (ideally logging to the sidecar) so list paths drop corrupt files instead of throwing; add a regression test with a foreign `.md`.

### 13. [60 · bug · 15–60m · confidence: high] Curator config read-path doesn't re-validate interval/confidence → runaway runs
**Location:** `packages/core/src/curator-config.ts:107-110,126-130`
**Problem:** `parseNumber` accepts `0`/negatives/fractions. The write path validates, but the product is explicitly built around out-of-band edits to a git-backed settings file. An interval of `0` makes `nextScheduledRun(last, 0) === last`, so `isIntervalDue` is always true → every slice runs every tick (unbounded LLM spend/writes). A corrupted `auto_apply_confidence` of `-1` would auto-apply everything regardless of model confidence. The read path is the actual gate the scheduler uses.
**Fix:** Clamp/validate in `readCuratorConfig` — floor interval to `MIN_INTERVAL_MINUTES` (integer-coerce), clamp confidence to `[0,1]`, falling back to defaults.

### 14. [60 · security · 15–60m · confidence: high] Raw submission text persisted to the vault unredacted on `create_new`/`propose`
**Location:** `packages/core/src/consolidator/apply.ts:113-120`
**Problem:** The `create_new`/`propose` branch builds the memory from the **raw** `submissionText` (`deriveTitle` + `body`) with no redaction (`createMemory` doesn't redact). Only the `curator_note.rationale` is redacted. So a secret in an inbox submission that routes here lands in the vault — and git history — verbatim. (The curator rejects secret-bearing ops; the consolidator has no equivalent gate on this path.)
**Fix:** Run `redactSecrets` over the derived title/body before `createMemory` on this branch (and consider the judge `create`/`supersede` outputs too).

### 15. [60 · bug/ops · 15–60m · confidence: high] Dashboard container healthcheck probes the heavy `/health` SSR page, not `/api/health`
**Location:** `docker/docker-compose.yml:72` · `pull-and-restart.sh:97`
**Problem:** `/api/health` is documented as the pure liveness probe (200 with no downstream dep); `/health` is an SSR readiness page that calls the MCP server. The compose healthcheck and `pull-and-restart.sh` probe `/health`, so: (1) when MCP is slow/down the dashboard container is marked unhealthy though its process is fine; (2) with auth enforcement on, `/health` (a page, not under the `/api` matcher exclusion) gets a 302→`/login`, so the probe passes for the wrong reason and stops reflecting health. The all-in-one Dockerfile correctly uses `/api/health` — the two-service path drifted.
**Fix:** Point both probes at `/api/health` (and fix the `pull-and-restart.sh` port: `…:3839/api/health`).

### 16. [60 · security · 15–60m · confidence: med] `clearSetupLinks` silently no-ops without `deleteSetting`, leaving prior setup links live
**Location:** `packages/core/src/auth/password.ts:264-269,276-291`
**Problem:** `mintSetupLink` documents a single-live-link invariant ("minting revokes any prior unused link") that relies on `clearSetupLinks`, which begins `if (!store.deleteSetting) return;`. `SettingsLike` types `deleteSetting` as optional, so on any store lacking it, minting does **not** revoke earlier links — every prior unexpired link stays redeemable in parallel. A leaked-but-thought-revoked link could still set the owner password.
**Fix:** Throw (fail closed) if `deleteSetting` is unavailable on the setup-link path, or have `clearSetupLinks` overwrite priors with an expired sentinel. The real markdown store implements `deleteSetting`, so promoting it to required here is low-risk.

### 17. [58 · vestigial · 1–3h · confidence: high] Async `createGitOps` (simple-git) is dead in prod yet drags the `simple-git` dependency
**Location:** `packages/core/src/store/git/git-ops.ts:1-87` · `store/git/index.ts:4` · `packages/core/package.json:41`
**Problem:** `createGitOps` (simple-git) has no production consumer — referenced only by its own test + barrel. The header claims it "serves the async consolidator/dashboard/backup," but all of those use `createSyncGitOps`/`cloneVaultBackup`. `simple-git` is imported **only** here yet ships to every install.
**Fix:** Delete `git-ops.ts` + its test + the `GitOps`/`createGitOps` exports; drop `simple-git` from `package.json`. (Verify no out-of-tree plugin imports it — none found in-repo.)

### 18. [52 · performance · 15–60m · confidence: high] `cosineSimilarity` recomputes the query norm for every doc on each recall
**Location:** `packages/core/src/store/index/vector-index.ts:18-41`
**Problem:** `search` maps `cosineSimilarity(query, entry.vector)` across all entries; inside, the **query** norm is recomputed per doc and each **stored** norm is recomputed every query though stored vectors are immutable. With 768-dim EmbeddingGemma vectors and N docs, that's ~2–3× the necessary arithmetic on the recall hot path the consolidator hits per item.
**Fix:** Precompute the query norm once before the loop; precompute+store each entry's norm at build time; score `dot / (normA * entry.norm)`.

### 19. [52 · security · 15–60m · confidence: high] Backup webhook allows internal targets (SSRF) and cleartext `http://`
**Location:** `packages/core/src/backup/config.ts:126-130` · `backup/run.ts:31-43`
**Problem:** `writeBackupConfig` validates only that `webhookUrl` starts with `http(s)://`. The failure webhook is then POSTed by the server to any configured URL — `http://169.254.169.254/…`, `http://localhost`, internal hosts — an SSRF primitive (admin-gated to set, but server-originated). It also permits cleartext `http://`, sending failure events (with infra hostnames) unencrypted. `redirect:"error"` is correctly set (caps redirect-follow) but doesn't address the initial-request SSRF.
**Fix:** Require `https://`; reject loopback/link-local/RFC-1918 hosts (or explicitly document internal webhooks as a supported use case).

### 20. [48 · bug · 15–60m · confidence: high] Proposal approve/reject/archive silently swallow action failures
**Location:** `apps/dashboard/components/memories/proposals-view.tsx:18-30` · `simple-list.tsx:55-60`
**Problem:** `onAction` awaits the action then immediately `router.refresh()`, discarding the returned `{ ok:false, error }` (the actions return errors as data, not throws). A failed approve produces no user-visible feedback — the row re-renders and the owner believes it worked.
**Fix:** Capture the result; on `!ok` surface `error` (toast/inline) and skip the refresh; plumb an error state through the list's action handler.

### 21. [48 · performance · 3–8h · confidence: high] Per-sweep full index rebuild re-reads the whole corpus per applied item
**Location:** `packages/core/src/store/librarian-store.ts:170-179,226-231` · `corpus-index.ts:44-81`
**Problem:** `onWrite` nulls the cached index, so the next recall during a sweep rebuilds the keyword inverted index, link graph, and vector index for the **entire** corpus (re-reading every file), once per applied item — O(items × corpus). The caching embedder fixes the embed cost, but index *construction* + full vault re-read remain. The code acknowledges it ("fine while sweeps are serial"); it's the largest remaining scaling cliff.
**Fix:** Batch index invalidation across a sweep (rebuild once at sweep end) or incrementally add the single changed doc to existing indexes.

### 22. [48 · dependency · 15–60m · confidence: high · `[tracked]`] `next` bundles vulnerable `postcss@8.4.31`
**Location:** `apps/dashboard/package.json` → `next@15.5.18 > postcss@8.4.31`
**Problem:** `pnpm audit` flags GHSA-qx2v-qp2m-jg93 (PostCSS XSS, patched ≥8.5.10) on the prod path. Real-world exploitability is low for a self-hosted admin dashboard not processing untrusted CSS, but it's a live prod advisory and CI has no `pnpm audit` gate. (Dev-only criticals — `vitest <4.1.0`, `esbuild`/`vite` — also present but dev-tree.)
**Fix:** Add a `pnpm.overrides` forcing `postcss >=8.5.10` (backward-compatible in 8.x) or bump Next; add a non-blocking `pnpm audit --prod` CI step.

### 23. [46 · security · 1–3h · confidence: med] Restore-clone validation accepts any repo containing one Librarian-shaped dir
**Location:** `packages/core/src/backup/restore-staging.ts:72-76,98-104,138-140`
**Problem:** `isLibrarianVault` returns true if the clone is a git repo with *any one* of `memories/inbox/references/handoffs/skills`. A backup remote pointed at an attacker repo with an empty `skills/` passes, and `applyPendingRestore` swaps it in at boot (live data preserved in `.pre-restore.bak`, so reversible — but the running store then serves attacker-controlled memories/handoffs/**skills**, which are executed guidance). No provenance check ties the clone to the configured origin.
**Fix:** Require the canonical multi-directory layout (not any single dir); gate `stageRestore` behind the validated slug; record + verify expected repo identity in the marker.

### 24. [45 · bug/test-gap · 15–60m · confidence: high] `consolidator-eval --gate` without `--baseline` gates nothing and exits 0
**Location:** `packages/consolidator-eval/src/cli/run-command.ts:130-140`
**Problem:** `gate` is computed only when `flags.baselinePath` is set, and `gateFailed = Boolean(flags.gate && gate && !gate.passed)`. So `--gate` without `--baseline` → `gate undefined` → `gateFailed false` → exit 0. A misconfigured regression-gating CI job reports green while checking nothing.
**Fix:** In `parseRunFlags`, throw if `flags.gate && !flags.baselinePath` (`"--gate requires --baseline <path>"`); add a unit test.

### 25. ⚠️ [45 (re-scored from 86) · security · 15–60m · confidence: high · `[tracked]`] `backup.github.repo` unvalidated on the env/read path — defense-in-depth, **not** token exfil
**Location:** `packages/core/src/backup/config.ts:101-115` · `backup/sync/github-config.ts:46-57`
**Problem:** `resolveBackupRemote` builds `https://x-access-token@github.com/${gh.repo}.git` with no slug check, and the env fallback `LIBRARIAN_BACKUP_GITHUB_REPO` is read with no validation. The shape validator (`isValidGithubRepoSlug`) is applied only at the tRPC write boundary (PR #311). **Lead reviewer correction:** the original agent scored this 86 on a "token redirected to an attacker host" premise — I verified that's **not achievable**: `${repo}` is interpolated in the URL **path**, after the `github.com` authority is already terminated by `/`, so no repo value can move the host; the token always goes to github.com. Real impact is a confusing deep-in-git failure (the teaching-error gap) plus a defense-in-depth inconsistency (write path validates, read/env path doesn't).
**Fix:** Call `isValidGithubRepoSlug` inside `resolveBackupRemote`/`resolveGithubSyncConfig` and throw on failure, closing the env bypass and enforcing the invariant where the URL is built.

### 26. [45 · security · 15m · confidence: high] `private_key`/`signing_key`/`encryption_key` missing from the redaction keyword list
**Location:** `packages/core/src/curator-redaction.ts:36-38`
**Problem:** `ASSIGNMENT_KEYWORDS` has `secret_key`/`api_key`/`access_key`/`account_key` but not `private_key` (the most common), `signing_key`, or `encryption_key`. The PEM rule only catches full armored blocks, so a bare `private_key=<hex>` assignment slips through into the LLM prompt and the vault.
**Fix:** Add `private[_-]?keys?|signing[_-]?keys?|encryption[_-]?keys?` to the list (cheap, low-risk).

### 27. [44 · test-gap/security · 1–3h · confidence: high · `[tracked]`] `check-no-secrets-in-vault` scans only the default-layout working tree
**Location:** `scripts/check-no-secrets-in-vault.mjs:38-50,64-74`
**Problem:** The guard asserts the invariant only for `<dataDir>/vault`, skips `.git` (so git **history** — which is what gets pushed — is never scanned: a secret ever committed then removed still leaks), and never exercises the `LIBRARIAN_VAULT_PATH` overlap (#2). Its coverage is narrower than the invariant it claims to pin.
**Fix:** Add a `git log -p`/`git grep` history scan for the canary; add a case asserting the store refuses to start (once #2 is fixed) when the vault would contain a secret file.

---

## Medium — condensed

Format: **[severity · effort · confidence]** location — problem → fix.

- **[42 · 15–60m · high] dead-code** `apps/dashboard/components/ui-v2/{filter-chip,hairline,inspector,key-hint,tabs}.tsx` — five redesign design-system components with zero app imports, kept alive only by `ui-v2.test.tsx`. → Delete (verify with owner per house rules) or note they're staged.
- **[42 · 15m · high] dead-code** `packages/core/src/schemas/common.ts:24-27` — `PROTECTED_CATEGORY_STRINGS` has zero importers; its justifying "sessions still carry visibility" comment describes a deleted router. → Delete the const + comment.
- **[42 · 15–60m · high] bug** sidecar stores `settings-store.ts:48-57`, `conversation-state-store.ts:50-53`, `curation-store.ts:97-100` — bare `writeFileSync` (non-atomic) unlike `backup-runs.json`'s temp+rename; a crash mid-write truncates `settings.json` → silent total loss of the password hash + encrypted token, and `readAll()→{}` can flip toward the no-auth posture. → Temp-file + `renameSync` (keep `0o600`).
- **[42 · 1–3h · high] vestigial** `curator-worker.ts:75-88` + `curation-store.ts:108,138` + `curation-types.ts:20,32` — `dry_run` vs `apply` mode is dead: the worker only ever creates `apply` runs, yet a `mode` field + `=== "apply"` filter imply a dry-run path that doesn't exist. → Wire a real preview run or drop `mode`.
- **[40 · 1–3h · high] vestigial** `store/{memory,handoff,curation,settings,conversation-state}-types.ts` + their `*-store.ts` shims — post-SQLite, each `*-store.ts` only re-exports its `*-types.ts`; nothing else imports the types files; comments ("concrete SQLite implementation lives in…") are now false. → Inline the types back into the `*-store.ts` callers use; delete 5 files.
- **[40 · 15m · high] dead-code** `schemas/common.ts:79` — `DEFAULT_AGENT_ID` duplicated; every consumer imports the `constants.ts:18` copy, the schemas copy has zero importers. → Delete the schemas copy.
- **[40 · 15–60m · high] bug** `packages/cli/src/runtime.ts:35-56` + `bin.ts:11-24` — `rebuild`/`seed`/`backup`/`export` run uncaught (only `auth`/`handoffs` are wrapped), so a thrown error escapes as a raw V8 stack trace (violates "errors teach, no stack trace"). → One try/catch at the bin boundary returning `{stdout:"Error: …", exitCode:1}`.
- **[40 · 1–3h · high] performance** `curator-source-vault.ts:100-124` — per tick, `1 + 3·S` full-corpus reads+parses (listSlices + 3 selects per due slice) over an unchanging snapshot. → Read/parse once per tick; pass the snapshot to the source.
- **[40 · 1–3h · high] test-gap** `store/git/sync-git-ops.ts:137-165` — the GIT_ASKPASS helper + stderr/message token-scrubbing has **zero** tests (the push test uses a tokenless local repo, "verified by construction"). → Add a test forcing an auth failure and asserting the token is `***` in `.message`/`.stderr`, absent from argv/`.git/config`, and the askpass temp dir is removed.
- **[38 · 15–60m · med] vestigial** `store/memory-types.ts:17-22,38-43` — `Memory` carries D16-retired `category`/`visibility`/`scope` with no readers (not even persisted). → Drop them (verify no dashboard/trpc destructure first).
- **[38 · 15m · high] dead-code** `packages/mcp-server/src/mcp/visibility.ts:15-19,51-66` — `isSessionVisible` + `SessionLike` (keyed on retired `created_by_agent_id`) exported with zero callers. → Delete.
- **[36 · 1–3h · med] maintainability** `curator-apply.ts:28-55` vs `consolidator/apply.ts:17-32` — duplicated `ApplyStore` interface + redacted-`curator_note` builder (op-routing legitimately differs; the store surface + note builder are the same contract copied twice). → Extract the shared interface + builder.
- **[34 · 1–3h · med] vestigial** conversation-state `session_id` — `conv-state-render.ts:18` says it was dropped, but `schemas/conversation-state.ts:19,31` still *requires* it, `store/sidecar/conversation-state-store.ts:73,84` persists it, and `mcp-server/.../conv-state-upsert.ts:22,36` advertises it. Nothing reads the value. → Drop end-to-end (or mark optional + "retained, unused").
- **[34 · 1–3h · med] bug** `curator-apply.ts:229-245` — `correctedMemory` rebuilds protected-update proposals from `existing.visibility`/`scope`/`category`, which post-cutover markdown memories don't populate (always `undefined`), so the proposal drops slice attributes the prompt treats as immutable. → Reconstruct from fields the markdown store actually carries; derive visibility from the slice.
- **[34 · 1–3h · med] performance** `store/index/caching-embedder.ts:40-53` — sha1-keyed cache never evicts; the "bounded by active memories" claim fails because every `update`/groom mints a new key while old vectors linger → unbounded heap growth with grooming history. → LRU sized to a few× active count, or sweep to the active set on `reindex`.
- **[33 · 1–3h · high] vestigial** `store/librarian-store.ts:117-123` — `InternalLibrarianStore = LibrarianStore` alias, two interchangeable names across ~10 cli/mcp-server files. → Find/replace to `LibrarianStore`; delete the alias.
- **[32 · 15–60m · high] test-gap** `consolidator-eval/.../run-command.ts:136-137` (via `cli.test.ts:140-151`) — `Gate: FAIL (tolerance 0.05)` prints to real stdout during a passing test → reads as a failure, erodes trust. → Spy on `process.stdout.write` in the two e2e tests; don't change production print behavior.

## Low & Nit — one-liners

- **[30 · 15–60m · high] bad-practice** mcp `verify-memory.ts:24`/`update-memory.ts:20`/`archive-memory.ts:22`/`approve-proposal.ts:23` — `store.X(...)!` non-null assertions on calls that actually `throw` (contract says `Memory|null`). → Drop `!`, add explicit teaching guard.
- **[30 · 15m · med] bad-practice** `secret-crypto.ts:63-65` — entropy guard only rejects all-identical-byte keys; the comment oversells it. → Narrow the comment or reject low-distinct-byte-count keys.
- **[30 · 15–60m · high] waste** `corpus/frontmatter.ts:90` ≡ `markdown/memory-doc.ts:81` ≡ `handoff-doc.ts:71` (`coerceDates`); scalar-escaper dup'd `frontmatter.ts`/`inbox.ts`. → Extract a shared `yaml-scalar.ts`.
- **[30 · 15–60m · med] ops bug** `pull-and-restart.sh:122,127-130` — error paths `exit 1` without `restore_state`, stranding the repo stashed on `main`. → `trap restore_state EXIT`.
- **[28 · 15–60m · high] performance** `curator-redaction.ts:145-154` — each `/g` regex run twice (count+replace) + a dead identical ternary. → Single `replace` with a counting replacer.
- **[28 · 15–60m · med] bad-practice** mcp `recall.ts:18-28` — `limit` unclamped; negative `limit` → `.slice(0,-n)` silently drops results (tRPC recall clamps; the agent surface is looser). → Clamp `1..50` like `RecallInputSchema`.
- **[28 · 15–60m · high] bad-practice** dashboard `keyboard-host.tsx:101-102` — `g m`/`g h` use `window.location.href` (full reload) vs the palette's router. → `useRouter().push`.
- **[28 · 1–3h · med] maintainability** `markdown/memory-doc.ts:65`/`handoff-doc.ts:55` — use `matter.stringify` (single-quoted, js-yaml defaults), undercutting the "byte-stable double-quoted" contract the corpus serializer hand-rolls. → Route through the canonical serializer, or fix the comments.
- **[28 · 15–60m · med] maintainability** `curator-enqueue.ts:39` — `DEFAULT_LOCK_TTL_MS` hard 60min, but worst case is `slices × timeoutMs` (up to 10min each); the asserted safety margin isn't guaranteed and equals the poll interval. → Derive from `llm.timeoutMs` or document the invariant.
- **[26 · 15–60m · high] react-antipattern** dashboard `simple-list.tsx:21,48-63` — one `useTransition` flag disables every row's buttons. → Track a `busyId` like `token-list.tsx`.
- **[26 · 15–60m · high] dead-code** `consolidator/judge-step.ts:27` — `CONSOLIDATOR_PROMPT_VERSION` exported but feeds no hash/cache (unlike the curator's). → Wire into the outcome audit or downgrade the comment.
- **[26 · 15–60m · med] bad-practice** mcp `schemas.ts:14-16` — `agent_id` marked `required`, contradicting resolve-from-token; a correct token-auth call that omits it is advertised invalid. → Drop from `required`.
- **[26 · 15–60m · high] maintainability** `corpus-index.ts:91-117` — "no cache" comment misleads; reference embeds *are* cached at the embedder layer (only the cheap keyword index rebuilds per call). → Correct the comment.
- **[24 · 15–60m · high] maintainability** `consolidator/judge.ts:143-163` ≡ `curator-output.ts:147-175` — `stripCodeFence`/`summarizeIssues`/`isRecord` duplicated (security-sensitive output parsing). → Extract a shared module.
- **[24 · 1–3h · high] maintainability** mcp `store-handoff.ts:18-30` vs `schemas/handoff.ts:36-51` — handoff bounds hand-written as JSON Schema **and** Zod (the five-headings rule exists only in Zod). → Generate `inputSchema` from Zod or add a lockstep test.
- **[24 · 15–60m · med] bad-practice** dashboard `(memories)/actions.ts:106-124` — `bulkUpdateMemoriesAction` forwards client `ids`/`patch` unbounded (relies on upstream zod). → Validate + cap `ids.length` at the action boundary.
- **[22 · 1–3h · med] performance** dashboard `proposals/page.tsx:11`/`archive/page.tsx:11` — hard `limit:100`, no pagination; rows past 100 silently invisible. → Paginate or show "first 100 — N more".
- **[22 · 15m · med] bad-practice** `secret-crypto.ts:142-159` — `decryptSecret` doesn't strictly validate base64 (GCM auth backstops it, so not exploitable). → Validate canonical base64 or annotate.
- **[22 · 15–60m · med] dead-code** `store/index/link-graph.ts:19-35` — `restrictToKnownIds:false` branch (F12 link-rot) has no caller; recall always passes `true`. → Flip to always-on until F12 lands (confirm first).
- **[22 · 1–3h · med] performance** consolidator `judge-step.ts:71-85` — candidate bodies/ToC built into the prompt with no per-field truncation (the curator truncates). → Truncate candidate bodies + ToC titles.
- **[22 · 15–60m · med] test-gap** `curator-scheduler.ts:35-48` — `selectDueSlices` has no direct test (only indirect). → Add `curator-scheduler.test.ts`.
- **[22 · 15–60m · med] performance** dashboard `filters.tsx:53`/`rehome-modal.tsx:41` — two `distinctValues` queries, no `staleTime`, refetch on remount. → Add `staleTime`.
- **[20 · 15m · med] dead-code** `markdown-memory-store.ts:531,540` — `startContext` passes `include_private:true` to `searchMemories`, which never reads it (D16 leftover). → Remove the flag.
- **[20 · 15m · med] dead-code** `markdown-memory-store.ts:263` — `verifyMemory` `|| result === "wrong"` is unreachable (enum is `useful|not_useful|outdated`). → Drop the clause.
- **[20 · 15–60m · med] bad-practice** mcp `dispatch.ts:33-39,71-78` — `params.name as string` / `arguments as Record` with no shape check (`Unknown tool: undefined` doesn't teach). → Validate `name` is a string and `arguments` an object.
- **[20 · 15–60m · med] bug** `store/index/reference-section.ts:24-38` — fence heuristic (`/^(```|~~~)/`) mis-tracks on indented/unbalanced fences in hand-edited references (bounded: wrong section, never a crash). → Allow ≤3 leading spaces; track marker pairing.
- **[18 · 15–60m · high] bad-practice** dashboard `api/auth/[...nextauth]/route.ts:17-24` — throttle keys on the spoofable leftmost `x-forwarded-for` hop (store lockout backstops it). → Use a trusted client IP / global fallback bucket.
- **[18 · 15–60m · med] maintainability** consolidator `navigate.ts:54-58,67-77` — defensive `String(memory.title ?? "")` casts + silent `.slice(0,200)` ToC truncation hide an unasserted store contract. → Tighten `Memory` typing; lock `listActive` ordering.
- **[18 · 15–60m · med] performance** `llm-connection.ts:92` — `hasToken` via `listSettings().some(...)` (full enumeration) on every curator/consolidator tick. → Add a keyed `hasSetting`.
- **[18 · 15m · high] maintainability** `llm-connection.ts:10,132-138` — "Only resolveLlmToken decrypts" comments attribute the no-decrypt-on-read guarantee to the wrong function (decryption is in `getSetting`). → Reword.
- **[18 · 15–60m · med] vestigial** `store/librarian-store.ts:65,214` — `backend:"markdown"` discriminator written, never read. → Remove (verify no external reader).
- **[16 · 15–60m · med · `[tracked]`] dead-code** `backup/runs.ts:23-25` — `bytes` always 0, `bundle` overloaded as the commit SHA (bundle-era vestige). → Drop `bytes`/`synced`, rename `bundle→commit` (dashboard-coordinated).
- **[14 · 15m · high] vestigial** `fly.toml:15` — "memories + sessions" volume comment. → "memories + handoffs".
- **[12 · 15m · high] vestigial** `cli/src/commands/export.ts:1-2` — header says "memories + sessions"; export emits memories only. → Drop "+ sessions".
- **[12 · 15m · med] waste** dashboard `(memories)/actions.ts:128-137` — `recallAction` (a read) calls `revalidatePath("/")`. → Remove it.
- **[12 · 15m · med] vestigial** mcp `trpc/memories.ts:70-73` — comment validates `visibility` "because sessions use it" (sessions retired). → State the real reason.
- **[8 · 15m · med] vestigial** `.dockerignore:5-7` — `*.sqlite*` ignores for artifacts no longer produced. → Remove.

## §Cluster — vestigial SQLite/sessions comment & config drift (~14 sites · agg severity ~35 · 1–3h total · high)

The SQLite backend and session subsystem were removed but their **explanatory comments** survive across the data-model and config, now actively misleading ("events.jsonl is the source of truth," "rebuilt SQLite projection," retired `Session*` enums "the single source of truth"). None are bugs; collectively they rot the mental model. A single comment-sweep PR:
`schemas/memory.ts:1-3,40,66-67,82-85,30-36` · `schemas/common.ts:1-9,36-40,73-75` · `schemas/conversation-state.ts:7-11` · `constants.ts:4-5` · `caller-backfill.ts:12-15,99` · `store/conversation-state-types.ts:4-5` + `store/sidecar/conversation-state-store.ts:4-5` · `vitest.config.ts:11-15` (`node:sqlite` rationale). (The `fly.toml`/`export.ts`/`.dockerignore` items above are the config-side members of the same cluster.)

---

## Appendix — checked and found correct / intentional (not flagged)

Recorded so the next reviewer doesn't re-litigate:
- **Crypto:** AES-256-GCM uses a fresh 96-bit random IV per call, proper auth-tag handling, versioned `gcm1` envelope; scrypt params (N=16384,r=8,p=1) reasonable with per-record params + `timingSafeEqual`; all-zero key correctly rejected.
- **Git token handling:** GIT_ASKPASS feeds the token via child env only; never in URL/argv/`.git/config`; `err.message`/`.stderr` scrubbed; temp dir 0700 + `finally` cleanup. (The missing pieces are credential-helper isolation (#5) and test coverage (#36) — the mechanics are sound.)
- **Auth:** every tRPC `.mutation` is `adminProcedure`-gated; the only `publicProcedure`s are `health.*` (no secrets/writes); `enableAuth` is admin-token-gated, validates completeness, and `tokensMatch` fails on empty; the lockout idle-window anchors to `lastFailureAt` (defeats paced drip-feed); setup links + agent tokens are salted-SHA-256 + timing-safe + single-use; `isAuthConfigComplete` is deny-by-default; the "no admin token ⇒ admin" path is the intentional localhost-dev affordance (warned at boot, refused beyond localhost). The middleware fail-closed table is correct.
- **Recall:** the caching embedder's O(N²)→O(N) fix is real + well-tested; query/document embedding asymmetry is load-bearing; RRF fusion, neighbour-decay ranking, and Tier-0/Tier-1 namespace isolation are correct; `truncateToTokenLimit` is correct.
- **Curator/consolidator split:** mostly clean and intentional (separate op schemas, prompts, validate/apply, lock substrates); the shared LLM client/config/redaction reuse is deliberate. `decideApply`'s protected-archive→skip / archive-not-proposable wrinkle is consistent. Fail-soft no-op try/catch + reaper-loop are intentional.
- **Dashboard:** the `/logs`+`/recall` removal is clean (no dangling routes/nav); no client component imports server-only secrets; OAuth/backup/token secrets are write-only in forms; the `configComplete` mirror is guarded by the new equivalence test.
- **Store/vault:** the `within()` path-escape guard is correct; inbox claim/reap filename round-trip is correct; the handoff `claim` single-process race comment is accurate + load-bearing.
- **CLI/CI:** removed guards (`check:no-store-bypass`, `check:storage-fixture`) are fully gone (only archival doc refs remain); `supervisor.mjs` crash-fast/signal logic and the `bin.ts` double-close guard are correct.

---

*Generated by 9 parallel review agents + lead synthesis & top-tier verification. Severities and effort are estimates; med/low-confidence findings are leads to confirm, not facts. Recommended next step: fix the top ~10 (≈1–1.5 days) — start with #1 (proxy allowlist), #3 (`redirect:"error"`, 15 min), #7 (broken audit script), and the redaction gaps (#11/#14/#26).*
