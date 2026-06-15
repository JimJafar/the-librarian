# Spec: `librarian server` + admin-CLI hardening (post-migration bug cluster)

**Status:** Ready to build, 2026-06-15. Grounded against `main` @ v1.0.0-rc.21.

## 1. Objective

A real migration (unprivileged-LXC + snap docker → native docker on a new host)
surfaced a cluster of `librarian server` / folded-in admin-CLI bugs that made
restore-from-backup into a fresh deployment impossible without manual `docker exec`
workarounds. Fix the ones that are code bugs; document the one that isn't (snap
docker). Audience: self-hosters, especially anyone restoring a backup onto a new
host. The `git checkout --end-of-options` bug from the same session already shipped
in #384 (rc.21) and is out of scope here.

## 2. Success criteria

Each becomes a regression test that fails before the fix and passes after.

1. **The admin CLI can read encrypted settings (root cause).** The `the-librarian`
   binary builds its store with the resolved master key (`LIBRARIAN_SECRET_KEY` env
   → `<dataDir>/secret.key` file), so `getSetting` on a secret (e.g.
   `backup.github.token`) returns the decrypted value instead of throwing. Result:
   `restore` resolves a **dashboard-saved** (encrypted) backup remote via
   `resolveBackupRemote` — no false `No backup remote configured` when a repo+token
   are set in the dashboard.
   *Test:* a settings store with an encrypted `backup.github.token` + the key in env
   → the CLI-constructed store reads it back; `resolveBackupRemote` is non-null.

2. **`server up` preserves an existing master key.** When `<deployDir>/deploy.env`
   already carries `LIBRARIAN_SECRET_KEY`, a re-run of `up` **reuses** it (mints
   nothing), so secrets encrypted under it (curator token, backup PAT) stay
   decryptable. A first deploy (no existing key) still mints + surfaces one.
   *Test:* `runUp` with a pre-existing `deploy.env` key → new `deploy.env` carries
   the SAME key, and the key is NOT re-surfaced as freshly minted; no existing key →
   mints + surfaces. DEPLOYMENT.md rung-(c) wording reconciled to match.

3. **`server admin` no longer dies with "the input device is not a TTY".** It
   requests a docker pseudo-TTY (`-t`) only when it will actually prompt AND the
   exec inherits a real stdin; otherwise it runs the verb non-interactively. With
   `--secret-key` supplied (no prompt), `restore` runs to completion regardless of
   the caller's stdin.
   *Test:* the exec argv for `restore --secret-key X` omits `-t`; an interactive
   prompt path (no key) uses an stdin-inheriting exec, not the capture runner that
   ignores stdin.

4. **The dashboard can restore into a fresh deployment.** The Restore control is
   enabled when a backup **remote is configured** (repo + token present), not gated
   on local successful-run history — so a brand-new deployment with zero runs but a
   valid remote can stage a restore.
   *Test:* config has repo+token and zero `ok` runs → the restore affordance is
   enabled (server-side `canRestore`/equivalent is true).

5. **The snap-docker incompatibility is documented and detected.**
   - **README/DEPLOYMENT** gain a clear note: `librarian server` is unsupported on
     **snap docker** — snap confinement can't read hidden build-context dirs and
     doesn't emit stdout to non-TTY pipes (which silently breaks `up`'s health/log
     capture). Recommend native `docker-ce`; give the non-hidden `--dir` note for
     anyone who must use snap.
   - **Detection (the fixable part):** when `up`'s health-poll reads **empty** output
     from `docker inspect` where a status is required (the snap symptom), it raises a
     teaching error naming the likely snap-docker cause and pointing at the docs —
     instead of the cryptic `did not become healthy … (no log output captured)`.
   *Test:* an injected runner returning empty stdout for the health inspect →
   `up`/`waitForHealthy` throws an error whose message names snap docker + the docs.

6. **Releasable.** One root `package.json` bump + dated `CHANGELOG.md` entry +
   compare-link (`check:release`); `build`/`lint`/`typecheck`/`test`/`check:test-count`
   green; **one PR, not merged.**

## 3. Scope

**In:** the five fixes above + the docs + the single release. Each ships with a
regression test (Criterion 6 of AGENTS.md).

**Out:**
- Full snap-docker support (PTY-wrapping every docker spawn) — documented as
  unsupported instead (§5).
- Changing the default deploy dir away from the hidden `~/.librarian/server`
  (behavior change; README + `--dir` suffices).
- The `git checkout --end-of-options` fix — already shipped (#384 / rc.21).
- Remote-dashboard topology, at-rest vault encryption, auth model changes.

## 4. Key decisions

- **P1 fix location:** `packages/cli/src/bin.ts` resolves the key (env →
  `<dataDir>/secret.key`) and passes it to `createLibrarianStore({ secretKey })`.
  Reuse the existing core key-resolution helper (`resolveSecretKey` + the same
  env→file order boot uses) rather than re-implementing. This is the single highest-
  impact fix — every admin verb that reads a secret depends on it.
- **P2 fix:** in `runUp`, read `<deployDir>/deploy.env` first; if it has
  `LIBRARIAN_SECRET_KEY`, reuse it; else mint. Surface "minted" vs "reused" honestly
  in the output (only a freshly-minted key gets the SAVE-THIS-KEY banner). Mirrors
  how `update` already preserves the key.
- **P3 fix:** give the admin runner an stdin-inheriting exec mode for the genuinely
  interactive prompt path; for non-interactive (a `--secret-key`/value already
  supplied, or no TTY) drop `-it` entirely. The capture runner that uses
  `stdio:["ignore",…]` must never be paired with `-t`.
- **P4 fix:** compute the restore-enabled flag from `resolveBackupRemote`/config
  (`repo` + `hasToken`) — server-side — and pass it to the button instead of
  `runs.some(status==="ok")`. Keep the typed-confirmation guard.
- **P5 detection:** treat a persistently-empty `docker inspect` health read as a
  distinct failure with a teaching message; keep it conservative (only when output
  is empty, exit code aside) to avoid false positives on native docker.

## 5. Open questions

None blocking — owner pre-authorised an autonomous build to a non-merged PR
(2026-06-15). Decisions in §4 are the chosen defaults; revisit at review.

## 6. Task plan (ordered; each leaves the system green)

- [ ] **P1 — admin CLI reads encrypted settings.** `bin.ts` resolves + passes the
      master key to `createLibrarianStore`. *Accept:* SC-1 test (CLI store reads an
      encrypted setting; `resolveBackupRemote` non-null with a dashboard-style token).
      *Depends:* none. *(root cause — first)*
- [ ] **P2 — `up` reuses an existing master key.** *Accept:* SC-2 test (reuse when
      `deploy.env` has a key; mint when not; banner only on mint). Reconcile
      DEPLOYMENT.md rung-(c). *Depends:* none.
- [ ] **P3 — `server admin` TTY handling.** *Accept:* SC-3 test (no `-t` for
      `restore --secret-key`; interactive path inherits stdin). *Depends:* none.
- [ ] **P4 — dashboard restore enabled by remote config.** *Accept:* SC-4 test
      (enabled with repo+token + zero runs). *Depends:* none.
- [ ] **P5 — snap-docker docs + detection.** README/DEPLOYMENT note; `up` teaching
      error on empty health-inspect output. *Accept:* SC-5 test + docs present.
      *Depends:* P2 (same `up.ts` region — serialize after P2).
- [ ] **P6 — release gate.** Single root version bump (rc.22) + dated CHANGELOG +
      compare-link; full gate green; open PR (do NOT merge). *Accept:* SC-6.
      *Depends:* P1–P5.

## 7. Checkpoint

Owner is asleep and pre-authorised straight-through `sdlc-spec → sdlc-orchestrate`
to a single non-merged PR. Build P1→P6, adversarially review the whole diff with a
fresh-context pass, re-run the full gate against merged HEAD (exit codes, no
`tail`/`head` on a gate), then open the PR and stop.
