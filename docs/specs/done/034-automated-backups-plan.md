# Plan: Automated backups — implementation orchestration

Companion to [`033-automated-backups-spec.md`](./033-automated-backups-spec.md).
The spec defines *what* each PR (A1–A6) builds; this plan defines the *order*,
what can go in parallel, the merge gate between each, the consolidated risks, and
the go-live sequence. Read the spec's "Plan (PRs)" for per-PR files/tests/acceptance.

## How to read this

Six PRs, one change each (AGENTS.md), every one independently shippable and
**dark by default** — the scheduler self-gates on a config that ships disabled, so
nothing in A1–A5 changes runtime behaviour until an operator turns it on in the
cockpit (A6). That means we can land the whole engine incrementally with zero risk
to a running instance.

## Dependency graph

```
        ┌──────────────────────────── A6 (cockpit + docs)
        │                              ▲   ▲   ▲   ▲
        │   ┌──────────────────────────┘   │   │   │
   A1 ──┴──────────────► A5 (restore) ──────┘   │   │
  (gzip)                  ▲                      │   │
                          │                      │   │
   A2 ──┬──► A3 ──────────┴──► A4 ───────────────┘   │
 (github)│ (config/        (retention)               │
         │  schedule/                                │
         │  health) ──────────────────────────────────┘
         └──► (BackupTarget.deleteBundle, run.ts target resolution)
```

Edges (X → Y = Y depends on X):

- **A1 → A5** — *hard*. Restore must gunzip a `format_version` 2 bundle; A5 applies
  one on boot, so A1's gzip-aware `restore.ts` must land first.
- **A2 → A4** — *hard*. Retention's `pruneTarget` calls `BackupTarget.deleteBundle`,
  introduced in A2.
- **A2 → A5** — *soft*. Staged restore can pull a bundle from a cloud target
  (`fetchBundle`); needs A2's target resolution. (Local-only restore doesn't.)
- **A3 → A4** — *hard*. Pruning reads `config.retention.keep` from A3's backup config.
- **A2, A3, A4, A5 → A6** — *hard*. The cockpit surfaces all of them (target config,
  schedule/runs, retention, restore + restart).
- **A1 ⟂ A2** — independent (different files: A1 = `backup.ts`/`restore.ts`;
  A2 = `sync/*`, `run.ts` target resolution).

## Sequencing

### Single worker (recommended): the spec's serial order

`A1 → A2 → A3 → A4 → A5 → A6`. Every dependency is satisfied left-to-right, and the
three files touched by more than one PR stay conflict-free because the edits are
serialized:

| Shared file | Touched by | Kept clean by |
|---|---|---|
| `backup/run.ts` | A2 (target resolution), A3 (run recording), A4 (prune-after-success) | serial A2→A3→A4 |
| `bin/http.ts` | A3 (settings-driven scheduler), A5 (boot-time staged restore) | A3 before A5 |
| `trpc/backup.ts` | A5 (`stageRestore`, `restart`), A6 (config/runs/list) | A5 before A6 |

### Two workers (if parallelizing)

- **Track P (engine/restore):** A1 → A5
- **Track Q (cloud/lifecycle):** A2 → A3 → A4
- **Converge:** A6 after both tracks land.
- **One coordination point:** `bin/http.ts` is edited by A3 (Q) and A5 (P). Land A3
  before A5, or have the two edits target disjoint regions (scheduler block vs. the
  pre-store-open restore block) and reconcile on merge. Everything else is
  track-local.

Parallelism buys little here (the critical path A1→A5→A6 is ~the same length as the
serial chain), so **prefer the single-worker serial order** unless two agents are
genuinely free.

## Merge gate (every PR)

A PR merges only when **all** of these are green — this is the verification
checkpoint between phases:

1. `pnpm run lint && pnpm run typecheck` clean (lefthook will enforce on commit).
2. `pnpm test` green (the PR's new RED-first tests included).
3. `pnpm run smoke` passes against a real local server.
4. The spec's **Acceptance** line for that PR is demonstrably met.
5. A `CHANGELOG.md` `[Unreleased]` entry is in the same PR.
6. No secret/token in code, tests, fixtures, logs, or error strings.

Plus per-PR "definition of done" highlights:

- **A1** — a hand-written **v1** (uncompressed) bundle still restores; a corrupted
  `.gz` is refused before any file swap; new bundle measurably ~70%+ smaller.
- **A2** — against a **real private GitHub repo** (manual smoke, not just mocks):
  backup → a Release with assets appears; `deleteBundle` removes the Release **and**
  the tag (verify no orphan tag); a bad token fails on save with a teaching error.
- **A3** — toggling the config on/off in core flips the scheduler; every run leaves
  a `backup_runs` row; a forced failure POSTs the webhook (mock) and records `error`.
- **A4** — drive 16 backups with keep=14 → exactly 14 remain on local **and** the
  cloud target; the prune is logged, not silent.
- **A5** — stage a restore → restart → `recall`/`listAll` match the bundle; a corrupt
  bundle is refused at stage time with live data untouched.
- **A6** — connect a target + set cadence in the UI → a scheduled backup appears →
  banner shows last success → a failure shows the error → one-click restore stages
  and the warned restart prompt renders.

## Risks & mitigations (consolidated)

| Risk | Mitigation | Owning PR |
|---|---|---|
| `backup_runs` schema bump mis-handled (rebuild drops it) | Confirm the `memory_curation_runs` migration precedent *before* coding; assert the table survives `rebuild` in a test | A3 |
| `bin/http.ts` boot order — restore must run **before** the store opens | Explicit pre-store-open block + a test that simulates the marker on boot | A5 |
| GitHub API misuse (orphan tags, asset upload host, rate/size limits) | Mock-based contract tests + a mandatory **live** smoke against a real repo at the A2 gate; surface teaching errors on 401/403/422 | A2 |
| `format_version` 1→2 back-compat regression | Explicit "old v1 bundle restores" test; `format_version` is the only branch | A1 |
| Restore replay cost on large ledgers | Replay only fires on schema-version mismatch; same-version restore is a straight binary swap | A5 |
| Cockpit leaking a secret back to the browser | Secrets are write-only (`hasX` booleans on read); covered by the existing `backup.config` pattern + a test | A6 |
| Restore-now button shuts down an unsupervised local instance | Inline Decision-10 warning on the button; no auto-restart assumption | A6 |

## Go-live sequence (after A6 merges)

The feature ships dark; enabling it is an operator action, exercised on the
canonical instance:

1. **Connect a target** in the cockpit — S3 *or* GitHub (save creds; validated on
   save).
2. **Set cadence + retention** (default keep=14) and enable the schedule.
3. **Backup now** → confirm a bundle locally and in the cloud target; confirm the
   `backup_runs` row + green banner.
4. **Force a failure** (e.g. a bad cloud cred) → confirm the red banner + webhook.
5. **Stage a restore** from a recent bundle → use the warned **Restart now** (the
   canonical instance runs supervised) → confirm `recall` matches.
6. Add an operator-chore line to `docs/TODO.md` only if a follow-up surfaces.

## Out of scope (tracked elsewhere)

- **Ledger/log rotation** — its own spec (the deferred companion; Option-B
  canonical-dump revisits here).
- **Master-key rotation (`rekey`)** — `docs/TODO.md` › Security & hardening.
