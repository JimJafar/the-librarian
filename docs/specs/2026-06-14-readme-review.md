# Spec: README review & improvement sweep

**Status:** Ready to build, 2026-06-14. Method: the `readme-review` skill (clarity +
correctness + usefulness, *verifying every claim against the code*), under the
AGENTS.md rule **"README is the contract."** Lightweight spec — a docs-quality
sweep, not an architectural change.

## 1. Objective

Make every README in the repo clear, correct, and useful to a consumer who's never
seen the project — so the install one-liners actually work, the feature claims are
true, and a reader gets from zero to a first success by following the page. The
front door (root README) and the five harness integrations are the priority; two
internal READMEs get a lighter correctness-only pass.

## 2. Success criteria

Per README (the acceptance bar; each is checkable):

1. **Claims verified against the code.** Every install command, CLI command, flag,
   path, env var, link, version, and package name is confirmed against the actual
   code/behaviour — or cut/corrected. No aspirational or stale content.
2. **Zero-to-first-success path works** on a clean machine: the documented install
   + quickstart, followed literally, gets a consumer running.
3. **First questions answered up top**, in plain language: what is this & why care →
   can I use it (status/requirements/license) → how do I start.
4. **Current reality only** — reflects `main` @ rc.7 (including the shipped
   `librarian server` command group); does **not** document unbuilt features (e.g.
   the ADR-0008 auth/secrets changes).
5. **No drift-prone duplication** — topics owned by `DEPLOYMENT.md` /
   `CONTRIBUTING.md` / ADRs are linked, not restated.
6. **Consistent across the set** — one install story, one tone, sensible cross-links;
   no two READMEs contradict each other.
7. **Releasable** — `pnpm run check:release` green; PR(s) bump version + CHANGELOG.

## 3. Scope

**Consumer-facing (priority — full skill pass):**
- `README.md` (root, the front door)
- `integrations/{claude,codex,opencode,hermes,pi}/README.md`
- `packages/installer-cli/README.md` (`@the-librarian/cli`)

**Internal/dev (lighter — correctness pass only):**
- `packages/intake-eval/README.md`, `scripts/seed/README.md`

**Out of scope:** generated/API reference; the unbuilt ADR-0008 features; a
docs-site restructure. Housekeeping: `integrations/hermes/.pytest_cache/README.md`
is a pytest auto-generated artifact — gitignore it, don't edit it.

## 4. Key decisions

- **Apply the `readme-review` skill** to each file; its core move — *verify claims
  against the code* — is what makes this a review, not a reformat.
- **Tailor by role:** root = the full story; each integration = install + use for
  *that* harness; a package README = focused on that package's consumer.
- **The root README sets the house shape** (structure, install story, tone); the
  others conform to it.
- **Document current reality** (rc.7), never the roadmap.

## 5. Open questions (defaults chosen; confirm at the checkpoint)

1. **Internal READMEs:** include `intake-eval` + `seed`? *Default: yes, but a
   correctness-only pass (don't gold-plate dev-internal docs).*
2. **PR grouping:** one PR for all, or split? *Default: split into three —
   (a) root, (b) the five integrations, (c) the packages — for reviewability.*
   (Reconsider if you'd rather one "merge-everything" PR.)

## 6. Task plan

Vertically sliced (one README or coherent group per slice), root first (it sets the
shape + has the biggest consumer impact). Each slice's acceptance = the skill's
"Done when" applied to that file: claims verified, zero-to-success works, structure +
plain-language top, no stale/duplicated content.

- [ ] **R1 — root `README.md`.** The front door; establishes the house structure,
      install story, and the `librarian` / `librarian server` command coverage.
      *Accept:* claims verified (incl. the rc.7 server commands); install + quickstart
      run clean; first-questions up top.
- [ ] **R2 — `integrations/claude`** *(template the integration shape here, reuse
      for R3–R6).* *Accept:* install + use for Claude Code verified against the code.
- [ ] **R3 — `integrations/codex`** · **R4 — `integrations/opencode`** ·
      **R5 — `integrations/hermes`** · **R6 — `integrations/pi`.** *Accept (each):*
      that harness's install + usage verified; consistent with R2's shape + the root.
- [ ] **R7 — `packages/installer-cli` (`@the-librarian/cli`).** *Accept:* the
      `librarian` install/usage matches the shipped CLI; consistent with the root.
- [ ] **R8 — internal READMEs** (`intake-eval`, `seed`) correctness pass; + gitignore
      the `.pytest_cache` artifact. *Accept:* no false claims; clearly marked internal.
- [ ] **R9 — consistency + release gate.** Cross-README consistency check (one install
      story, working cross-links); `check:release` green; version bump + CHANGELOG; PR(s).

## 7. Checkpoint

Independent files → parallelizes cleanly (good fit for `sdlc-orchestrate`: one slice
per README, each with a verify-against-code pass + a fresh-eyes review). Confirm the
§5 defaults, then build. Independent of the auth/secrets work — its own PR(s).
