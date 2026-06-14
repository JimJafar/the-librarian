# Spec: integration guardrails — make Librarian use enforceable, not just advised (ADR 0009)

**Status:** Phase 1 **ready to build** — Q1–Q4 resolved 2026-06-14 (§5); pending
[ADR 0009](../adr/0009-integration-enforced-librarian-use.md) acceptance on merge.
Phase 2 is gated on the P-D discovery. Written with the `sdlc-spec` method,
grounded against the integrations on `main`.

## 1. Objective

Make "use The Librarian instead of a file" the enforced default on every harness
the Librarian ships an integration for — starting with the one harness that can
enforce it authoritatively (Claude Code), and being honest about the rest. The
primer already *tells* agents to use the Librarian and that has been shown
insufficient (ADR 0009 Context); this adds the enforcement the primer can't be.

Grounded facts this builds on:

- The integrations are in-tree under `integrations/<harness>/` (ADR 0007 D14) and
  are wired into each harness by `librarian install` (the installer-cli).
- The **Claude Code** integration today ships `integrations/claude/.mcp.json`, a
  plugin manifest `integrations/claude/.claude-plugin/plugin.json`, the four
  slash commands, and a README — and **no hooks** (verified: a tree-wide grep for
  `hooks` / `PreToolUse` / `SessionStart` returns nothing under `integrations/`,
  `.claude/`, `.claude-plugin/`).
- The teaching surface is the primer (`vault/primer.md`, default in
  `packages/core/src/primer.ts`), served as MCP `instructions` + `GET /primer.md`.
- Sacred rules that constrain this work: **fail-soft** (never block the user's
  turn), **private mode** `[librarian:private=on]` (no writes), the **7-verb**
  surface + drift-guards (untouched), and **cross-harness contracts change
  together** (AGENTS.md §2).

## 2. Success criteria

The acceptance bar; each becomes a test.

1. **Authoritative block (Claude Code).** With the Librarian installed, a `Write`
   (or `Edit`/`MultiEdit`) that creates a **handoff-shaped** file (e.g.
   `HANDOFF.md`, `*-handoff*.md`, `*takeover*.md`) or a **durable-memory-shaped**
   file (a write into a local agent memory store, e.g. `**/.claude/**/memory/**`,
   `**/MEMORY.md` in that store) is **denied**; the file is not created; the
   denial message names the verb to use (`store_handoff` / `remember`).
2. **No false positives.** Writes to ordinary paths are **not** blocked: source
   code, `docs/**`, `vault/primer.md`, a spec under `docs/specs/`, a project's
   own `src/.../memory.ts`. Verified against a fixture set of legit paths.
3. **Taught, in-band override (Q4).** The denial message states that this is a
   heuristic block and that, **if it's a genuine false positive with a good
   reason not to use the Librarian, the agent may override and write the file
   anyway** by re-issuing the write with a recognized override marker (proposed:
   an `<!-- librarian-guard: override — <reason> -->` sentinel in the content).
   A write carrying the marker succeeds; the override is logged to the sidecar so
   it's auditable. The message names *when* an override is legitimate, not just
   *how*.
4. **Fail-soft.** If the guard script errors or times out, the tool call
   **proceeds** (the user's turn is never blocked) and the failure is logged to
   the local sidecar, not surfaced as a stack trace. Verified by inducing a guard
   error.
5. **Private mode blocks too (Q2).** During `[librarian:private=on]`, a
   handoff/memory-shaped write is **blocked**, with a message explaining that
   nothing durable is being written **anywhere** — not to a file, not to the
   Librarian (it can't be; private mode forbids server writes). The guard makes
   **no** server call. The taught override (SC 3) still applies for a genuine
   need.
6. **Shipped + updatable by the CLI.** `librarian install` writes the guard into
   the Claude Code config; re-running it updates the guard; the uninstall path
   removes it. No hand-editing of machine settings is required or expected.
7. **Honest capability matrix.** A documented table states, per harness
   (Claude Code, Codex, OpenCode, Hermes, Pi), whether it gets **authoritative**
   enforcement or **nudge-only**, and why. No integration's docs claim
   enforcement it doesn't have.
8. **Contracts intact + releasable.** The 7-verb surface, protocol docs, and
   drift-guard tests are unchanged; `pnpm test` / `typecheck` / `lint` green; PR
   bumps root version + dated CHANGELOG (`check:release`).

## 3. Scope

**Phase 1 (in):** the Claude Code authoritative guard — a `PreToolUse` hook that
**blocks** handoff/memory-shaped writes with a teaching message (including the
taught override and the private-mode variant), shipped via the integration and
installed by the CLI; the conservative filename/path matcher; fail-soft; the
capability-matrix doc seeded with Claude Code = authoritative.

**Phase 2 (in):** extend to the other four harnesses at the **strongest primitive
each supports** (discovery task P-D), filling in the matrix honestly; where a
harness has a pre-action veto, an authoritative guard; where it doesn't, the best
available nudge (and, optionally, a PostToolUse detect-and-warn).

**Out of scope (this spec):**

- **Intercept-and-redirect** — catching the write and *automatically* constructing
  a valid `store_handoff`/`remember` call from its content. The better UX and the
  eventual goal, but it carries real correctness risk (synthesizing a schema-valid
  handoff from arbitrary prose) and depends on Phase 1 landing first. Deferred to
  its own spec (Q1 resolved: Phase 1 ships block-with-teaching, which is safe).
- Changing the primer's content, the 7-verb surface, or any protocol.
- An adversarial control (ADR 0009 threat model): we are not trying to defeat an
  agent that *wants* to evade the guard.

## 4. Key decisions (from ADR 0009 + §5)

- **Block-with-teaching, not auto-redirect (Q1).** Phase 1 denies the write and
  tells the agent the right verb. Simple, safe, and would have prevented the
  triggering incident. Auto-redirect is a later, separately-specced enhancement.
- **Conservative, allowlist-aware matcher (Q3).** Match on a small, high-precision
  set (handoff/takeover filenames; writes into a known agent memory-store path) —
  never on vague "notes-shaped" content. Bias hard toward false-negatives over
  false-positives. Patterns live in one shared place so all integrations agree.
- **The override is taught, not configured (Q4).** No env var, no out-of-band
  switch: the denial message itself teaches that a genuine false positive can be
  overridden in-band (a recognized marker), and what counts as a good reason. The
  guard nudges and educates; it never imprisons.
- **Private mode blocks, never redirects (Q2).** In private mode the guard blocks
  the matched write and explains that nothing durable is written anywhere; it
  makes no server call.
- **Fail-open on guard error.** Per fail-soft: the guard's own failure allows the
  write. Enforcement that risks blocking the user's turn is worse than none.

## 5. Resolved (were open questions, 2026-06-14)

1. **Q1 — Phase 1 behavior → block-with-teaching.** Deny + name the verb. Reliable
   and fast; auto-redirect (intercept-and-construct the call) is deferred to its
   own spec once the guardrail is proven in practice. *(Owner, 2026-06-14.)*
2. **Q2 — private mode → block it too.** A matched write under
   `[librarian:private=on]` is blocked with "nothing durable is written anywhere
   — not a file, not the Librarian." No server call. The taught override still
   applies. *(Owner, 2026-06-14. Defines a corner of the private-mode contract —
   carry it into the private-mode docs alongside the primer/slash-command set.)*
3. **Q3 — matcher → conservative, filename/path-based.** Seed patterns:
   filenames matching `/(^|[-_/])handoff/i` or `/(^|[-_/])takeover/i` with a `.md`
   extension; writes under a local agent memory store
   (`**/.claude/**/memory/**`, `**/MEMORY.md` therein, and the per-harness
   equivalents found in P-D). Explicitly **not** matched: `vault/primer.md`,
   `docs/**`, the server's own data dir, ordinary source. Ships with a fixture set
   of must-block / must-allow paths. *(Owner, 2026-06-14.)*
4. **Q4 — escape hatch → taught, in-band override.** No env var or external
   switch. The denial message explains that the block is heuristic and that a
   genuine false positive (a real reason not to use the Librarian) may be
   overridden by re-issuing the write with a recognized marker (proposed
   `<!-- librarian-guard: override — <reason> -->`); the override is logged to the
   sidecar. The message teaches *when* this is legitimate, not only *how*.
   *(Owner, 2026-06-14. Exact marker token confirmed at build in P2.)*

**Still open (discovery, not an owner decision):**

- **Q5 — per-harness enforcement primitives (Phase 2).** Which of Codex,
  OpenCode, Hermes, Pi expose a *pre-action* veto vs. only instructions? Unknown
  without per-harness investigation — that's task **P-D**, and it gates which
  harnesses get authoritative guards vs. nudge-only.

## 6. Task plan

Vertically sliced, riskiest/most-valuable first. Each slice leaves the system
working and shippable.

### Phase 1 — the Claude Code authoritative guard

- [ ] **P1 — match logic + fixtures (no harness wiring yet).** A small, pure
      module: `classifyWrite(path, content?) → { blocked, verb, reason }` with the
      §5-Q3 pattern list. Ship a fixture set: must-block (`HANDOFF.md`, a
      `.claude/.../memory/x.md`) and must-allow (`vault/primer.md`,
      `docs/specs/foo.md`, `src/memory.ts`). *Accept:* SC 1 (logic) + SC 2.
      *(riskiest — the false-positive surface lives here.)*
- [ ] **P2 — the Claude Code `PreToolUse` hook.** Wire P1 into a hook on
      `Write`/`Edit`/`MultiEdit` that denies a matched write with the teaching
      message + the taught-override mechanism (confirm the exact marker token
      here), and **fails open** on its own error. Confirm the plugin-vs-settings
      wiring for shipping a hook with the Claude integration. *Accept:* SC 1
      (end-to-end), SC 3, SC 4.
- [ ] **P3 — private-mode block.** Detect `[librarian:private=on]` and block with
      the SC-5 message; make no server call. *Accept:* SC 5. *Depends:* P2.
- [ ] **P4 — install/update/uninstall via the CLI.** `librarian install` writes
      the hook into the Claude Code config; re-run updates it; uninstall removes
      it. *Accept:* SC 6. *Depends:* P2.
- [ ] **P5 — capability matrix doc (seed) + private-mode contract update.** The
      matrix table (Claude Code = authoritative; others = TBD pending Phase 2),
      pointed to from `integrations/claude/README.md`; fold the Q2 private-mode
      behavior into the shared private-mode docs. *Accept:* SC 7 (Claude Code row).
      *Depends:* P2.
- [ ] **P6 — Phase 1 release gate.** tests/typecheck/lint green; 7-verb +
      drift-guards untouched; version bump + CHANGELOG; PR. *Accept:* SC 8.
      *Depends:* P1–P5.

### Phase 2 — the other harnesses, honestly

- [ ] **P-D — discovery: per-harness enforcement primitives** (answers Q5). For
      Codex, OpenCode, Hermes, Pi: pre-action veto (→ authoritative) or
      instructions-only (→ nudge)? Document findings. *Depends:* none — run early,
      in parallel with Phase 1.
- [ ] **P7 — authoritative guards where a veto exists** (e.g. Pi if its extension
      supports a pre-tool hook), reusing the P1 match module. *Depends:* P-D, P1.
- [ ] **P8 — strongest nudge where no veto exists** (Codex/OpenCode/Hermes per
      P-D): a sharpened instruction line and/or a PostToolUse detect-and-warn
      fallback where the harness allows it. *Depends:* P-D.
- [ ] **P9 — complete + publish the capability matrix.** Every harness row filled,
      honest, cross-referenced from each integration README. *Accept:* SC 7 (all
      rows). *Depends:* P7, P8.
- [ ] **P10 — Phase 2 release gate.** Gate + PR. *Depends:* P7–P9.

## 7. Checkpoint

Phase 1 is the high-leverage, independently-shippable slice: it makes the one
harness that *can* enforce actually enforce. With Q1–Q4 resolved (§5), **P1–P6 are
ready to hand to `sdlc-implement`** once ADR 0009 is accepted on merge. Phase 2 is
gated on **P-D** — no integration should claim enforcement we haven't verified the
harness can deliver. The intercept-and-redirect north star stays deferred to its
own spec until Phase 1 proves the guardrail in practice.
