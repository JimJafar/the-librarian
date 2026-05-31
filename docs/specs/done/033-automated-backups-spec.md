# Spec: Automated backups — targets, schedule, restore, retention (dashboard-driven)

## Status

Drafted 2026-05-30. Six serial PRs (A1–A6). Extends the shipped backup engine
(`016-persistence-backup-restore`) with the automation, lifecycle and UI surface
it never had. **Extend, not replace** — see "Relationship to spec 016" below.

## Objective

Make backups **set-and-forget and self-serve from the dashboard**. Today an
operator gets a correct, consistent snapshot engine (VACUUM INTO + checksummed
bundle + S3 sync) but must drive the schedule through an env var, can't restore
from the UI, gets no failure signal, and accumulates bundles forever. Close that
gap:

- **Two cloud targets** the operator can connect from the dashboard: the existing
  **S3-compatible** storage, and a new **GitHub Releases** target.
- **Dashboard-configured frequency** (no more env-only schedule).
- **Observability**: the cockpit shows the **last successful backup** time and
  **alerts on failures** (persisted run health + a banner; optional webhook push).
- **List the recent backups** (most-recent 10) and **restore from one** — restore
  rebuilds/validates the SQLite memory projection on the way back in.
- **Retention**: keep the last **N = 14** bundles per target; prune the rest.

**Who it's for.** A single-owner self-hoster running The Librarian (local box or
an always-on Fly machine) who wants their `data/` directory protected without
remembering to do anything.

**Success looks like.** Connect a target + pick a cadence in the dashboard →
walk away → backups appear on schedule, old ones are pruned, the cockpit shows a
green "last backup 12m ago," and a one-click restore from any recent bundle
brings the store back (after a restart).

## Relationship to spec 016 (why extend, not replace)

The 016 engine is the correctness-critical core and stays: `createBackup`
(`VACUUM INTO` consistency), `restoreBackup` (checksum validation + path-traversal
guards + atomic temp-rename), the **key-free** bundle (`secret.key` excluded), and
the pluggable `BackupTarget` (`put`/`get`/`list`) seam. Replacing it would discard
tested, security-reviewed code to rebuild identical primitives. Everything this
spec adds is **additive**, layered on the existing seams, and mirrors the **memory
curator cockpit** — which already solved schedule-in-settings + persisted run
history + failure surfacing + run-now + a config form.

What exists today vs. what this spec adds:

| Capability | Today (016) | This spec |
|---|---|---|
| Consistent snapshot + restore engine | ✅ keep as-is | — |
| Bundle compression | ❌ stored uncompressed (~8 MB/bundle) | **A1** — gzip each file, `format_version` 2 (~73% smaller) |
| S3-compatible target | ✅ keep as-is | reused; config moves into the cockpit form |
| GitHub target | ❌ | **A2** — GitHub Releases `BackupTarget` |
| Schedule | env `LIBRARIAN_BACKUP_INTERVAL_MS` | **A3** — settings + cockpit, env becomes legacy fallback |
| Last-success / failure state | ❌ (only `logger.error`) | **A3** — `backup_runs` history + alert |
| Retention / pruning | ❌ | **A4** — keep last N per target |
| Restore from dashboard | ❌ (CLI only) | **A5** — restart-staged restore + tRPC |
| List recent (last 10) | lists *all* local | **A6** — limit + cloud + per-run status |
| Cockpit (form / banner / restore) | "Backup now" + read-only list | **A6** — full cockpit (clone of curator) |

## Non-goals

- **Not replacing the 016 engine or the `BackupTarget` contract.** The bundle
  format bumps to `BACKUP_FORMAT_VERSION` 2 (gzip, A1), but restore stays
  **backward-compatible** — existing v1 (uncompressed) bundles still restore.
- **Not changing the backup's authoritative shape.** The full
  `VACUUM INTO` SQLite binary stays in the bundle (gzipped). We explicitly
  **rejected** dropping the projection tables to ship only the canonical tables +
  rebuild-from-ledger on restore — see Decision 9.
- **Not JSONL ledger / log rotation.** `events.jsonl` is the *canonical* memory
  ledger; segmenting it means rebuild must read every segment in order — a
  distinct, higher-risk change. It gets **its own spec** (tracked separately).
  (App logs already go to stdout/stderr, not files — Docker/journald rotate them;
  nothing app-side to do there.)
- **Not in-process "hot" restore.** Restore is **restart-staged** (decision
  below) — we never swap `librarian.sqlite` under a live DB connection.
- **Not tiered/GFS retention.** Count-based "keep last N" only.
- **Not multi-target fan-out in one run.** A backup writes locally and syncs to
  the *one* configured cloud target (S3 *or* GitHub). Multiple simultaneous cloud
  targets is a later option behind the same interface.
- **Not changing `secret.key`'s exclusion** from bundles.

## Decisions (resolved with the owner)

1. **GitHub target = Releases + binary assets.** Each backup is a GitHub **Release**
   in a private repo (tag = bundle name), with the bundle's files attached as
   **release assets**. Retention deletes a whole Release — its assets *and* its
   tag — leaving no git-history residue (a Release isn't a commit in a chain).
   Chosen over committing
   blobs to a repo (binary SQLite bloats git history, hits size limits) and over
   the Contents API (same bloat + 100 MB/file cap). Releases are built for binary
   artifacts and prune cleanly. The admin must save a repo (`owner/repo`, **assumed
   to already exist** — we do not auto-create) + a fine-grained PAT in the cockpit
   **before** the GitHub target can be enabled; creds are **validated on save**
   (a cheap `GET /repos/{owner}/{repo}`) so a bad token/repo/scope fails
   immediately with a teaching error, not silently at the next scheduled run.
2. **Restore = restart-staged.** The dashboard *stages* a chosen bundle (validates
   it, writes a pending-restore marker); the actual file swap happens **on the next
   boot**, before the store opens. Safe by construction — never mutates the DB file
   under an open connection. A brief restart is required and is surfaced in the UI.
3. **Ledger/log rotation = separate spec.** Out of scope here (see Non-goals).
4. **Retention = keep last N, default 14, configurable.** Count-based prune applied
   per target after each successful backup; the cockpit lists the most-recent 10.
5. **Schedule + targets live in settings, configured from the cockpit.** The server
   scheduler tick **self-gates on the stored config** (mirrors the curator tick),
   so it's always safe to start. `LIBRARIAN_BACKUP_INTERVAL_MS` /
   `LIBRARIAN_BACKUP_*` env vars become a **legacy fallback** for headless setups,
   documented as superseded by the cockpit.
6. **Failure alerting = persisted run health + cockpit banner + webhook (v1).**
   Every run records to `backup_runs` (status, target, bytes, error). The cockpit
   shows last-success time and a red banner with the error on the most recent
   failure. A **failure webhook ships in v1**: when `backup.alert.webhook_url` is
   set (blank = disabled), a failed run POSTs **generic JSON** —
   `{ event: "backup.failed", at: <iso8601>, target: "local|s3|github",
   error: <scrubbed message>, bundle?: <name> }`. Failure-only (no success spam);
   the payload carries no secrets (error messages are already token-scrubbed); the
   POST is best-effort and never blocks or fails the backup.
7. **No new required dependencies.** GitHub uses Node 22's global `fetch` (bearer
   token in headers, `redirect: "error"` on credentialed calls). `@aws-sdk/client-s3`
   stays optional + lazy as today.
8. **Run history = a `backup_runs` SQLite table** (mirrors `memory_curation_runs`),
   not a settings ring — owner-confirmed. The exact `PROJECTION_SCHEMA_VERSION` /
   migration path is verified during A3 (see Risks).
9. **Gzip the bundle; keep the full binary (reject canonical-dump-only).** Each
   bundle file is gzipped (`node:zlib`), cutting a bundle from ~8 MB to ~2.2 MB
   (~73%). We measured the alternative the owner raised — back up only the
   *canonical* tables (`settings`, curator history, `handoffs`, `domains`,
   `conversation_state`, `signal_rules`, `token_domain_bindings` ≈ 177 KB / 26 KB
   gz) as a SQL dump and **rebuild the projection from `events.jsonl` on restore**.
   It is **lossless** (every mutable `memories` field — recall counts, usefulness,
   classification — is event-sourced, so `rebuildMemoryIndex` reconstructs them),
   but **rejected for now**: gzip already captures most of the size win, while the
   dump approach makes *every restore* a full ledger replay + schema-skew
   reconciliation — fragility in the one operation that must stay bulletproof, and
   replay cost grows with the (currently unbounded) ledger. Revisit it **paired
   with the deferred ledger-rotation spec**, where bounded segments make replay
   cheap and the rebuild path can be properly hardened.
10. **Restart after a staged restore = instruction + a warned "Restart now" button,
   ungated.** Once a restore is staged, the cockpit shows "Restart required to
   apply" *and* a **Restart now** button. The button carries a **warning**: it only
   brings the server back if an auto-restart supervisor is configured (Docker
   `restart:` policy, systemd `Restart=`, Fly, …); on a bare `pnpm start` it shuts
   the server down and it stays down. No `LIBRARIAN_SUPERVISED` env gate — the
   operator owns the choice, the warning informs it. The button calls an admin
   mutation that flushes + `process.exit(0)`s the mcp-server; `supervisor.mjs`
   crash-fasts the pair, the supervisor restarts it, and the staged restore applies
   on boot.
11. **CLI restore stays the direct, store-closed `restore --force`.** Staging is a
   dashboard-only affordance (the dashboard can't stop the live store, so it defers;
   the CLI operator already has the store stopped). No CLI staging command.

## Bundle contents (what each backup holds)

A bundle is a directory `librarian-backup-<iso>/` with exactly four entries
(each data file gzipped after A1; `manifest.json` stays plain). This is the
*existing* 016 contents — the spec only compresses them, it does not add or remove
files.

1. **`librarian.sqlite[.gz]`** — a `VACUUM INTO` consistent copy of the **entire**
   database, holding both:
   - **canonical-only** tables (live nowhere else): `settings` (incl.
     AES-256-GCM-**encrypted** secrets — curator token, S3/GitHub creds),
     `memory_curation_runs` + `_operations`, `handoffs`, `domains`,
     `conversation_state`, `signal_rules`, `token_domain_bindings`, `backup_runs`
     (added in A3); and
   - **projection** tables (rebuildable from the ledger): the `events` mirror,
     `memories`, `memories_fts*`, indexes.
2. **`events.jsonl[.gz]`** — the canonical append-only memory ledger (also mirrored
   inside the sqlite by design; the event log is stored twice — intentional, since
   we keep the authoritative binary).
3. **`memories.md[.gz]`** — derived human-readable snapshot; included **only if it
   exists** on disk.
4. **`manifest.json`** — `format_version` (2), `created_at`, `schema_version`
   (PRAGMA `user_version`, 19 today), and `files[]` with per-file sha256 + bytes
   (compressed + uncompressed after A1).

**Never in a bundle:** `secret.key` and `admin.token` (key-free by design — a
leaked bundle is not a leaked key; the encrypted `settings` secrets need the
original master key to decrypt on restore, via `restore --secret-key` / TTY
prompt). The retired `session_events.jsonl` / `sessions.legacy.jsonl`
`.predeprecation.bak` ledgers are not produced by the post-PR-7 backup path
(restore still tolerates them in older bundles). Nothing else under `data/` is
copied (no `backups/`, `restore.pending.json`, `.env`, …) — `createBackup` writes
only the named files.

## Tech stack

- `@librarian/core` — gzip in `backup.ts`/`restore.ts` (`node:zlib`); new
  `backup/sync/github.ts` (`fetch`-based `BackupTarget`), `backup/retention.ts`,
  backup config read/write (settings), `backup_runs` store helpers. Reuses
  `settings-store` (encrypted secrets), `serial-scheduler`, `run.ts`,
  `getSchemaVersion`/`rebuildMemoryIndex`.
- `@librarian/mcp-server` — extend `trpc/backup.ts` (config for both targets,
  schedule, runs, `stageRestore`); boot-time restore in `bin/http.ts`; the backup
  scheduler reads settings.
- `apps/dashboard` — a backups **cockpit** cloned from `app/curator/*` +
  `components/curator/*` (config form, config summary, runs table, run-now,
  restore button).
- `@librarian/cli` — `the-librarian backup`/`restore` keep working unchanged; add
  `--keep <n>` to expose retention to the CLI path.
- Node `fetch`, `node:fs`, `node:crypto`, `node:zlib`, `zod`. No new required deps.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm run build           # pnpm -r run build
pnpm run lint            # eslint + prettier (lefthook runs these on commit)
pnpm run typecheck       # tsc --noEmit across every workspace
pnpm test                # full vitest suite (build + unit + root)
pnpm run smoke           # end-to-end against a real local server
pnpm run healthcheck     # local /mcp + dashboard probes

# CLI backup path (unchanged + new --keep):
the-librarian backup --out /var/backups/librarian --keep 14
the-librarian restore --from /var/backups/librarian/librarian-backup-… --force
```

## Project structure

```
packages/core/src/backup/
  backup.ts                 # (modify) createBackup → gzip each file, manifest format_version 2
  restore.ts                # (modify) restoreBackup → gunzip; accept v1 (plain) + v2 (gz)
  run.ts                    # (modify) runBackup → record run + prune after success
  retention.ts              # (new)    pruneTarget(target, keep) + local prune
  config.ts                 # (new)    readBackupConfig / writeBackupConfig (settings)
  runs.ts                   # (new)    backup_runs: recordRun / listRuns
  sync/
    types.ts                # (modify) add deleteBundle() to BackupTarget (prune unit)
    config.ts               # (exists) S3 config — unchanged
    github.ts               # (new)    GitHub Releases BackupTarget (fetch-based)
    github-config.ts        # (new)    resolveGithubSyncConfig (settings + env)
    s3.ts memory.ts bundle.ts  # (exists)
packages/mcp-server/src/
  trpc/backup.ts            # (modify) config(both targets)/setConfig/schedule/runs/stageRestore
  bin/http.ts               # (modify) settings-driven scheduler + boot-time staged restore
apps/dashboard/
  app/backups/page.tsx      # (modify) cockpit shell (clone curator/page.tsx)
  app/backups/actions.ts    # (modify) server actions: setConfig / restore / run-now
  components/backups/        # (new)   config-form / config-summary / runs-table / restore-button
docs/specs/done/033-automated-backups-spec.md   # (this file, on completion)
```

## Code style

Match the existing target style — a small factory returning the `BackupTarget`
methods, credentials in headers only, no `any` leaking past the boundary (ADR
`0003-no-any`), `redirect: "error"` on credentialed calls:

```ts
// backup/sync/github.ts — Releases as bundles, assets as files. No SDK; global fetch.
export function createGithubTarget(cfg: GithubSyncConfig): BackupTarget {
  const api = "https://api.github.com";
  const headers = {
    authorization: `Bearer ${cfg.token}`,            // header only — never a URL/log
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  const release = (bundle: string) => `librarian-backup/${bundle}`; // tag name

  return {
    async put(name, data) {
      const [bundle, file] = splitBundleKey(name);    // "<bundle>/<file>"
      const rel = await ensureRelease(cfg, headers, release(bundle));
      await uploadAsset(cfg, headers, rel, file, data); // redirect: "error"
    },
    async get(name) { /* find asset by bundle+file, download bytes */ },
    async list(prefix = "") { /* releases → "<bundle>/<asset>" keys */ },
    async deleteBundle(bundle) { /* delete the Release + its assets + the tag ref */ },
  };
}
```

## Plan (PRs)

Six serial PRs, each independently shippable, tested RED-first, with a
`CHANGELOG.md` `[Unreleased]` entry per AGENTS.md. A1 lands first because the
restore PR (A5) must already understand the compressed bundle.

### A1 — Gzip the bundle (`format_version` 2)

- **Modify** `backup.ts` — gzip each bundle file via `node:zlib`
  (`librarian.sqlite.gz`, `events.jsonl.gz`, `memories.md.gz`); set the manifest
  `format_version` to 2 and record, per file, the stored (compressed) `sha256` +
  `bytes` **and** the uncompressed `sha256` (so restore can verify both the
  on-disk object and the decompressed content). `VACUUM INTO` still writes the
  binary first; gzip the temp file in place.
- **Modify** `restore.ts` — branch on `format_version`: v2 → verify the
  compressed checksum, gunzip, verify the uncompressed checksum, then atomic-swap;
  v1 → the existing plain path, unchanged. Keep the path-traversal `assertSafeName`
  guard on the *decompressed* target name.
- **Reuse**: the existing manifest/checksum/atomic-rename machinery; only the
  per-file read/write gains a (de)compression step.
- **Tests**: round-trip a v2 bundle (seed → backup → wipe → restore → `listAll`
  identical); a hand-written **v1** bundle still restores (back-comp); a corrupted
  `.gz` is refused before any swap; measured size assertion (compressed bundle
  materially smaller than the binary).
- **Acceptance**: new bundles are gzipped and ~70%+ smaller; both v1 and v2 bundles
  restore byte-faithfully.

### A2 — GitHub Releases backup target

- **Modify** `sync/types.ts` — add `deleteBundle(bundleName: string): Promise<void>`
  to `BackupTarget`. Retention's unit is the *whole snapshot*, not a single file —
  every cloud target needs it. Implement in `sync/memory.ts` (test double) too.
- **Create** `sync/github.ts` — `createGithubTarget(cfg)` implementing
  `put`/`get`/`list`/`deleteBundle` over the GitHub REST API with global `fetch`:
  bundle → Release (create-if-absent by tag), file → release asset (upload via the
  `uploads.github.com` asset URL), `deleteBundle` → delete the Release (which drops
  its assets) **and** the underlying tag ref, so no orphan tags accumulate (two
  calls: release delete + `DELETE /git/refs/tags/<tag>`).
  Bearer token in headers; `redirect: "error"`; token never logged.
- **Create** `sync/github-config.ts` — `resolveGithubSyncConfig(store, env)`:
  settings `backup.github.repo` (plain), `backup.github.token` (`{secret:true}`),
  env fallback `LIBRARIAN_BACKUP_GITHUB_REPO` / `LIBRARIAN_BACKUP_GITHUB_TOKEN`.
  Returns `null` when not configured (mirrors `resolveS3SyncConfig`).
- **Modify** `run.ts` — target resolution picks S3 *or* GitHub from config.
- **Tests** (`packages/core/tests/backup/sync/github.test.ts`): contract test
  against a mocked `fetch` (put → release+asset; list → keys; get → bytes;
  `deleteBundle` → release **and** tag removed); the `deleteBundle` contract added
  to the in-memory target test; a token-never-in-error assertion.
- **Acceptance**: `runBackup` with GitHub config creates a Release with the bundle
  files attached; `deleteBundle` removes the Release + tag (no orphan tag);
  credentials never appear in logs/errors.

### A3 — Backup config + schedule + run health in settings

- **Create** `backup/config.ts` — `readBackupConfig(store)` /
  `writeBackupConfig(store, patch)` (validated, like `writeCuratorConfig`):
  `enabled`, `interval_minutes` (≥1), `target` (`local|s3|github`),
  `retention.keep` (≥1, default 14), `alert.webhook_url?`. Secrets (S3/GitHub
  creds) continue to round-trip via the target config, never returned in reads.
- **Create** `backup/runs.ts` + `backup_runs` table (mirror
  `memory_curation_runs`): `recordRun({status, trigger, target, bundle, bytes,
  error})` and `listRuns({limit})`. Schema added via `ensureSchema` following the
  curator-runs precedent (verify the exact `PROJECTION_SCHEMA_VERSION`/migration
  path during implementation — see Risks).
- **Modify** `run.ts` — wrap each run: record `started`, on success record
  `ok` + bytes, on failure record `error` (+ optional webhook POST). The local
  bundle is always written before any sync, so a sync failure still records a
  partial-success the cockpit can show.
- **Modify** `bin/http.ts` — the backup scheduler tick **self-gates on
  `readBackupConfig`** (disabled/incomplete → no-op), timer driven by
  `LIBRARIAN_BACKUP_TICK_MS` (default 5 min); per-schedule `interval_minutes`
  enforced inside the tick (exact curator pattern). Env `LIBRARIAN_BACKUP_INTERVAL_MS`
  kept as a legacy fallback when no settings config exists.
- **Tests**: config validation round-trip; `recordRun`/`listRuns`; tick self-gates
  off when disabled, fires when due; webhook POST on failure (mocked fetch).
- **Acceptance**: schedule + target + retention are settable via core API and
  drive the scheduler; every run leaves a `backup_runs` row.

### A4 — Retention / pruning (keep last N)

- **Create** `backup/retention.ts` — `pruneLocal(dir, keep)` (remove oldest
  `librarian-backup-*` dirs beyond `keep`) and `pruneTarget(target, keep)`: `list`
  → derive unique bundle names (the `librarian-backup-<iso>` prefix sorts
  chronologically) → `deleteBundle` each one beyond `keep`. One delete per
  snapshot, uniform per target: local = `rm` the dir, S3 = delete the prefix's
  objects, GitHub = delete the Release + tag.
- **Modify** `run.ts` — after a successful backup + sync, prune local and the
  active cloud target to `config.retention.keep`. **Log what was pruned** (no
  silent deletion — AGENTS.md "error messages teach").
- **Modify** CLI `backup` command — add `--keep <n>` (defaults to config / 14).
- **Tests**: 16 bundles + keep 14 → 2 oldest removed, newest 14 kept, across local
  + memory target; keep ≥ count is a no-op; pruning never touches a half-written or
  in-progress bundle dir.
- **Acceptance**: scheduled backups hold steady at N bundles per target; the prune
  is logged.

### A5 — Restart-staged restore (+ projection rebuild)

- **Create** `backup/restore-staging.ts` — `stageRestore(store, bundleRef)`:
  resolve the bundle (local dir, or pull from the cloud target via `fetchBundle`),
  **validate the manifest + checksums without applying**, then write a
  `restore.pending.json` marker in `dataDir` (bundle path + manifest digest +
  staged-at). Refuse to stage a corrupt bundle.
- **Modify** `bin/http.ts` boot — **before opening the store**, if
  `restore.pending.json` exists: re-validate, run `restoreBackup(stagedDir, {dataDir})`,
  clear the marker, then open the store. Opening runs `ensureSchema`, which
  **rebuilds the memory projection from `events.jsonl`** if the bundle's
  `schema_version` is older. On any failure: abort (leave the live data
  untouched), keep the marker, log a teaching error. (Sessions are retired; the
  restored `librarian.sqlite` is authoritative for settings/conv-state/runs and is
  swapped in wholesale — never rebuilt from the ledger.)
- **Modify** `trpc/backup.ts` — `stageRestore` admin mutation (returns
  `{ staged: bundleName, restartRequired: true }`); `list` gains `restorable`; add
  a `restart` admin mutation that flushes logs and `process.exit(0)`s the
  mcp-server (the warned cockpit button calls it — Decision 10). `restart` returns
  before exit so the client gets an ack.
- **Tests**: stage → simulate boot → store reflects the bundle; corrupt bundle is
  refused at stage time (live data intact); marker survives a failed restore and
  is cleared on success; projection rebuilds when `schema_version` is older; the
  `restart` mutation triggers the exit path (mocked).
- **Acceptance**: a dashboard-staged restore applies on the next boot and the
  recalled memories match the bundle; a bad bundle never half-applies.

### A6 — Dashboard cockpit + docs

- **Modify** `trpc/backup.ts` — `config`/`setConfig` cover **both** targets
  (S3 + GitHub: `repo`, `token` write-only) + schedule + retention + webhook;
  `runs` (most-recent, default 10) for the history table; `list` capped at 10 with
  per-bundle sync status; keep `createNow`. Mount stays `backup` in `trpc/router.ts`.
- **Modify** `app/backups/{page.tsx,actions.ts}` and **create**
  `components/backups/{config-form,config-summary,runs-table,restore-button,
  restart-prompt}.tsx`, cloned from the curator cockpit:
  - **Config form**: pick target (S3/GitHub), enter creds (secrets write-only,
    shown as "configured"), set frequency + retention + optional webhook.
  - **Health banner**: green "Last backup <relative time>" from the latest `ok`
    run; **red** banner with the error from the latest failed run.
  - **Recent backups** (last 10): name, time, target, status; each row has a
    guarded **Restore** button → `stageRestore`.
  - **Post-restore restart prompt**: once a restore is staged, show a persistent
    "Restart required to apply this restore" banner with a **Restart now** button
    (→ `backup.restart`). The button carries the Decision-10 warning inline: *only*
    use it if an auto-restart supervisor is configured (Docker `restart:` / systemd
    `Restart=` / Fly); on a bare `pnpm start` the server will not come back.
- **Modify** `DEPLOYMENT.md` — replace the env-only schedule section with the
  cockpit flow; document the GitHub Releases target (fine-grained PAT scopes:
  contents + a private repo), retention, the restart-staged restore, and the
  gzipped `format_version` 2 bundle (note v1 bundles still restore). Keep the
  volume-snapshot alternative.
- **Tests**: dashboard action tests (mirror `tests/memories-actions.test.ts` /
  curator cockpit tests) for setConfig (both targets + webhook url), run-now,
  stage-restore, and the warned restart prompt rendering after staging; tRPC
  `backup.test.ts` extended for the new procedures incl. `restart` (admin-gated).
- **Acceptance**: connect a target + set a cadence in the UI → scheduled backups
  appear in the list → the banner shows last success → a failure shows the error →
  one-click restore stages and applies after restart.

## Testing strategy

- **Framework**: vitest (`pnpm test` = `pnpm -r run build && pnpm -r run test:vitest
  && vitest run`); dashboard component/e2e via the existing Playwright setup.
- **Locations**: core → `packages/core/tests/backup/**`; server → 
  `packages/mcp-server/tests/trpc/backup.test.ts`; dashboard →
  `apps/dashboard/tests/components/backups/**`.
- **RED-first** on every behaviour (AGENTS.md). Highest-value tests: gzip **v2
  round-trip** + a hand-written **v1** bundle still restoring (back-comp); GitHub
  target contract against mocked `fetch`; retention prune math; **restore
  round-trip** — seed → backup → wipe → stage → boot → assert `recall`/`listAll`
  identical; corrupt-bundle / corrupt-`.gz` refusal; credentials never in
  logs/errors.
- **Levels**: unit for core (targets, retention, config, runs); integration for
  the tRPC surface (admin-gated); component/action for the cockpit; `pnpm run smoke`
  end-to-end before merge.

## Boundaries

- **Always**: run `pnpm run lint && pnpm run typecheck && pnpm test` before a
  commit; write the failing test first; keep `secret.key` out of bundles; bearer
  tokens in headers only (never URLs/logs/errors); `redirect: "error"` on
  credentialed HTTPS; one change per PR + `[Unreleased]` CHANGELOG entry;
  fail-soft (a backup/sync/restore error must never throw out of a hook or block
  the user's turn — log + record + move on).
- **Ask first**: any *further* change to the bundle format beyond the approved
  `BACKUP_FORMAT_VERSION` 2 gzip bump (A1); the `PROJECTION_SCHEMA_VERSION` bump for
  `backup_runs`; adding a runtime dependency (the plan adds none); touching the
  cross-repo contracts (slash commands, memory state model, handoff shape — none
  expected here).
- **Never**: commit a populated `.env` or any token; `--no-verify` past lefthook;
  swap `librarian.sqlite` under a live connection (restart-staged only); delete a
  bundle outside the retention policy; touch the JSONL ledger rotation here.

## Success criteria

1. From the dashboard, an operator can connect **S3** *or* **GitHub Releases**,
   set a frequency + retention, and save — with credentials write-only.
2. Scheduled backups run on that cadence with no env var set; each produces a
   bundle locally and (if a cloud target is configured) in the cloud.
3. The cockpit shows the **last successful backup** time and a **failure banner**
   (with the error) when the most recent run failed.
4. The cockpit lists the **10 most-recent** bundles with their status.
5. **Retention** holds each target at the last **14** bundles; prunes are logged.
6. A one-click **restore** from a listed bundle stages safely and, after a
   restart, brings the store back so `recall`/`listAll` match the bundle; the
   memory projection is rebuilt/validated on boot; a corrupt bundle never
   half-applies.
7. GitHub uses **no new dependency**; the token never appears in logs/errors.
8. New bundles are **gzipped** (`format_version` 2) and ~70%+ smaller than today;
   existing **v1** (uncompressed) bundles still restore byte-faithfully.
9. `pnpm test`, `pnpm run smoke`, `pnpm run lint`, `pnpm run typecheck` all green.

## Risks / open items

- **`backup_runs` schema path.** Whether the table needs a `PROJECTION_SCHEMA_VERSION`
  bump (and a rebuild-safe migration) or can be a standalone admin table created by
  `ensureSchema` — confirm against how `memory_curation_runs` was introduced before
  writing A3. The table must survive a `rebuild` (it is *not* derived from the
  ledger), so it must not be dropped by `rebuildMemoryIndex`.
- **Bundle format bump (v1 → v2).** Restore must stay back-compatible: a v1
  (uncompressed) bundle on disk or in the cloud must still restore. Covered by an
  explicit back-comp test in A1; the `format_version` branch is the only divergence.
- **Rejected: canonical-dump-only backup (owner's Option B).** Verified lossless
  (projection fully rebuildable from `events.jsonl`; canonical residue ≈ 177 KB),
  but it turns every restore into a full ledger replay + schema-skew reconciliation
  — fragility in the recovery path, and replay cost tracks the unbounded ledger.
  Deferred to pair with the ledger-rotation spec. **Do not** reintroduce it here.
- **GitHub rate/size limits.** Release-asset uploads and listing are subject to API
  rate limits; a ~2 MB gzipped bundle is well under asset limits, but the target
  must surface a teaching error (not a silent failure) on 401/403/422.
- **GitHub orphan tags.** Deleting a Release does *not* delete its tag — `deleteBundle`
  must remove both, or retention would "prune" Releases while tags pile up. Covered
  by the A2 `deleteBundle` contract test (asserts the tag is gone).
- **Restore replay time** (A5) grows with ledger size only when the bundle's
  `schema_version` is older (forcing a projection rebuild). Same-version restores
  are a straight binary swap — no replay.

## Open questions

**None outstanding.** The three that were open are resolved into the spec:

- *Failure webhook* → **ships in v1**, generic JSON, failure-only (Decision 6).
- *Restart after restore* → **instruction + a warned, ungated "Restart now" button**
  (Decision 10; A5 mutation, A6 prompt).
- *CLI restore parity* → **`restore --force` stays as-is; staging is
  dashboard-only** (Decision 11).

The spec is ready for **Phase 2 (technical Plan)** on approval.
```
