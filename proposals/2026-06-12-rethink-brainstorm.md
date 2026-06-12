# Rethink: The Librarian from first principles

Working doc for the 2026-06-12 brainstorm. Sections 1–2 are frozen evidence; 3–9 are the iteration surface.

## 1. The question

The Librarian has been through ~6 months of iteration (v0.1.0 → v0.11.0) and is carrying feature drift and design-assumption debt. What is the simplest system that achieves the owner's goals — and what is the cheapest path from the current codebase to it (tweak, carve-down, or rewrite)?

## 1.5 Owner's framing (verbatim intent)

> "A beautifully simple and effective memory system that works for and with any agentic harness, enabling true self & group improvement."

Stated keepers: markdown as source of truth (portability, human read/editability), harness plugin APIs knowledge, the curator. Stated worry: e.g. skill storage/retrieval was added without knowing whether harnesses can even load skills from context. "Nothing is sacred" — open to full rewrite.

## 2. Audit (frozen, 2026-06-12, v0.11.0)

Four parallel audits: server core, curator, the five plugins, drift history. Condensed findings; full citations were verified against source.

### 2.1 What is solid

- **Markdown + git is genuinely the source of truth.** Vault at `<data-dir>/vault/`, deterministic YAML frontmatter (`packages/core/src/store/corpus/frontmatter.ts:19–29`), wikilinks + backlink graph (`packages/core/src/store/index/link-graph.ts`), surgical link rewrites for minimal diffs. The index (keyword + vector + link graph, RRF-fused, `packages/core/src/store/index/hybrid-index.ts`) is **fully disposable** — rebuilt from markdown, never written back. No graph DB exists despite the owner's mental model; the "graph" is the wikilink index. This is the strongest part of the system.
- **Handoffs are complete and minimal.** 5-section template enforced at the Zod boundary (`packages/core/src/schemas/handoff.ts:16–22`), atomic claim with 409 on race (`markdown-handoff-store.ts:97–100`). Shipped in v0.2.0 and never needed a follow-up.
- **The 9-verb agent surface is contract-tested** (`packages/mcp-server/tests/mcp/tool-registry.test.ts`, `scripts/healthcheck.js`): recall, remember, flag_memory, store/list/claim_handoff, list_skills, get_skill, search_references (+3 "internal" conv_state tools still publicly advertised).
- **The curator pipeline works and is observable**: intake (judge → route → apply with confidence thresholds) and grooming (slice-based, input-hash idempotent, locked, bounded, redacted, per-op audit). Addendums are 2KB git-versioned vault files with an under-evaluation force-propose mode.
- **Test discipline is real**: ~43k LOC source, ~23k LOC tests, debt tracked in docs/TODO.md not hidden in code.

### 2.2 The debt (by theme)

**Dead or shell features:**
- Skills: infrastructure complete (`skill-store.ts`, list/get verbs), **catalog empty in production** (ADR 0006 resolved decision #4: "production vault hosts no skills today"). Hermes structurally cannot call the skill tools at all (MemoryProvider ABC exposes only 3 fixed tools). Authoring UI deferred indefinitely. A shell.
- Classifier: routing reads a `pendingClassification` flag but the classifier worker itself is stubbed (`packages/core/src/store/memory-routing.ts:26–60`).
- Sessions: 13 MCP tools shipped v0.1.0, deleted v0.2.0; handoffs were the replacement but were **never taught to agents as the replacement**. Orphaned read-only dashboard views remain.
- Domains: added v0.4.0, removed v0.6.0; inert `domain` field lingers in markdown for back-compat.
- Three mature parked proposals (hybrid recall upgrade, fallback capture, healthcheck/benchmarks) with no spec.

**Half-finished migrations:**
- Phase-7 SQLite cutover: markdown backend is feature-complete but `createLibrarianStore` still conditionally returns SQLite per env flag (`librarian-store.ts:63–65`); dashboard/tRPC still wire old contracts. Dual-backend split-brain risk.
- Event ledger retired; dashboard logs/analytics now **throw** (`markdown-memory-store.ts:142–145`); the git-history replacement consumer was never built.
- conv_state tools: ADR 0006 says they don't belong on the agent surface; relocation deferred; they're still advertised on tools/list.
- References: no persistent embedding cache (first search after restart re-embeds everything — minutes); large docs truncated to ~2K tokens, chunking deferred.

**Duplication:**
- Curator: intake prompt (v4) and grooming prompt (v2) are ~60% identical, hand-synced; force-propose routing reimplemented in both `intake/apply.ts:149–170` and `grooming-apply.ts:145–160` despite a shared helper existing; 6 distinct entry points (intake sweep/run-now, grooming scheduled/run-now, dry-run slice/corpus) each with slightly different gate logic. Under-evaluation accept/rollback/re-evaluate lifecycle is structurally wired but **untested**.
- Plugins: five repos, no shared package (deliberate — "five-peer implementations" rule after `packages/lifecycle` was deleted in PR #153). ~1500 lines of byte-identical-by-convention MCP clients + conv-state/primer renderers maintained by hand across 5 repos in 2 languages. Every contract change = 5 coordinated PRs.
- The primer itself IS served centrally (one `conv_state_get` response field) — good. Only the wrapper/injection plumbing is duplicated.

**Cognitive load:** ~15 distinct concepts for an agent/contributor to hold (memory states, protection flags, two curator jobs, under-evaluation, conv_state, handoffs, skills, references, classifier, flags, primer, 9 verbs, …).

### 2.3 Discrepancy to check

The repo audit found the Claude plugin ships *no* slash commands (hook-only), yet the live Claude Code session has `the-librarian:handoff/takeover/learn/toggle-private/use-the-librarian` skills installed — installed version and repo HEAD may differ, or the audit missed a commands dir. *(Parked — moot under D9/D10: the Claude plugin repo is slated for archive, with optional command sugar becoming plain markdown prompts.)*

## 3. Reframing

The owner's one-sentence goal bundles **four jobs** that have been pulling the architecture in different directions:

1. **Memory** — recall/remember + curation so the corpus improves rather than rots. (The core. The curator is the differentiator.)
2. **Continuity** — one agent picks up where another left off (handoffs). Adjacent but distinct: handoffs are ephemeral-ish, claimed-once, narrative; memories are durable, deduplicated, atomic.
3. **Knowledge distribution** — pushing reference docs and "skills" down to agents. This is where drift happened: skills assumed a harness capability that doesn't generally exist.
4. **Governance** — admin approval, addendums, under-evaluation, dashboards. Meta-machinery whose right size depends entirely on who the users are.

The drift history is largely a record of jobs 3 and 4 growing, getting reworked, and shedding (sessions→handoffs, domains→nothing, verify→flag, 19→9 verbs, skills→empty shell). Jobs 1 and 2 have been stable since v0.2.0.

**Restated question:** keep jobs 1 + 2 as the product; decide deliberately how little of jobs 3 + 4 to keep; and shrink the integration surface so "any harness" stops costing 5 hand-synced repos.

## 4. Open questions

- **Q1 — Audience.** *(Resolved → D1.)*
- **Q2 — Group improvement in practice.** *(Resolved → D8: one shared corpus; namespacing unused.)*
- **Q3 — Skills.** *(Resolved → D2: kill outright.)*
- **Q4 — MCP `instructions` as the primer channel.** *(Resolved empirically — see §8.1. Claude Code: yes, ≤2KB. Codex: yes, as tool-namespace description. OpenCode, Hermes, Pi: no — but each has a one-hook native channel.)*
- **Q5 — conv_state's reason to exist.** It carries `conv_id` + `off_record`. Private mode is already moving to an in-conversation marker (`/toggle-private` "no server state"). With the primer riding MCP instructions / one-shot native channels (§8.1), conv_state has no remaining job → proposed for deletion under H7.
- **Q6 — Rewrite vs carve-down.** *(Resolved → D3: carve down.)*
- **Q7 — Curator governance sizing.** *(Resolved → D4: simplify to git.)*
- **Q8 — References' fate after D2.** *(Resolved → D5: keep, with cache + chunking fixes.)*

*(All open questions resolved as of 2026-06-12.)*

## 5. Working hypotheses

- **H1 — Carve down, don't greenfield.** *(Promoted → D3.)*
- **H2 — Fewer note types.** *(Promoted → D5: three types — memories, handoffs, references — with the reference cache + chunking fix. Skills dead per D2.)*
- **H3 — Primer over MCP instructions; plugins become optional.** *(Superseded by H7 after §8.1 evidence: only 2 of 5 harnesses honor `instructions`.)*
- **H4 — One curator, one prompt core, two triggers.** *(Promoted → D6.)*
- **H5 — Delete the stubs and orphans wholesale.** *(Promoted → D7.)*
- **H6 — Governance right-sized to audience.** *(Resolved by D1 + D4.)*
- **H7 — Tiered integration; conv_state dies.** *(Promoted → D10.)* The primer becomes a single ≤2KB operator-editable document served by the server, delivered per harness via the *thinnest native channel*:
  - **Tier 0 (no plugin at all):** Claude Code and Codex — primer rides MCP `instructions`; key "recall before answering / remember after learning" guidance also duplicated into tool descriptions as the portable fallback every harness renders.
  - **Tier 1 (one-hook shims):** OpenCode — `opencode.json` `instructions` accepts **remote URLs**, so a config line pointing at `GET /primer.md` may replace the plugin entirely; fallback is the `chat.system.transform` hook. Hermes — `MemoryProvider.system_prompt_block()`. Pi — `before_agent_start` returning `{systemPrompt}`.
  - **Consequences:** conv_state (3 tools, sidecar store, per-turn fetch plumbing in 5 repos) is deleted — `off_record` is already an in-conversation marker, and nothing else remains in the row. Per-turn primer freshness degrades to per-session (connect-time) — acceptable trade. Primer text must avoid phrases that trip Hermes's prompt-injection regexes (e.g. "ignore previous instructions"-shaped wording).
  - **Resulting agent surface: 7 verbs, 0 internal tools** — recall, remember, flag_memory, store_handoff, list_handoffs, claim_handoff, search_references.
  - Slash commands sub-question: *(resolved → D9: primer protocols + optional sugar).*

### Post-walk additions (2026-06-12, owner review)

- **H8 — Surviving integrations move into the monorepo.** *(Promoted → D14.)* Post-D10 the plugin estate is: Hermes adapter (Python), Pi extension (TS), Claude Code optional command sugar (markdown prompts), OpenCode + Codex (docs/config only). All move to `integrations/<harness>/` in the monorepo; the five external repos are archived. Distribution still works from subdirectories: the monorepo itself hosts the Claude Code marketplace (`.claude-plugin/marketplace.json` pointing at the subdir), the Pi extension publishes to npm from the pnpm workspace, the Hermes adapter installs via copy/script into `plugins/memory/`. Trade-off accepted: a Python package inside a TS monorepo (own test runner, CI matrix entry); marketplace installs pull the whole repo (acceptable; a CI-pushed mirror repo is the escape hatch if it ever isn't). Benefit: contract changes become one PR, one changelog, co-located tests — the residue of the five-peer coordination burden disappears.
- **H9 — The dashboard becomes a first-class vault explorer/editor.** *(Promoted → D15, Obsidian-lite scope.)* New top-level dashboard surface: file tree of the whole vault (memories, handoffs, references, `.curator/` addendums, primer); rendered markdown view with clickable wikilinks and a backlinks pane (the link graph already exists); raw editor with frontmatter validation on save; create/rename/delete with wikilink-integrity rewrites (machinery exists). All writes go through the store layer — git commit + index invalidation — never raw file writes. The primer becomes `vault/primer.md`, edited here like everything else (replaces a bespoke primer editor). The original theory ("admins checkout the repo and use Obsidian") demotes from assumed workflow to optional power path.
- **H10 — Git becomes a server-owned implementation detail.** *(Promoted → D16, extended with diff/rollback UI per owner.)* The server guarantees the vault is a git repo: init if absent, auto-commit per write (already the design), optional remote push = backup (already exists). Admins never need to know git is there; `git revert` rollbacks (D4) are exposed as dashboard actions ("restore this version") backed by git, with file history shown from git log. Evidence motivating this: the owner's live data dir carries a git vault *and* a 7MB `librarian.sqlite` + 4.2MB legacy `events.jsonl` side by side — the dual-backend limbo (audit §2.2) means even the system's own author can't be sure which store is live. D7's SQLite deletion plus H10 closes this permanently.

## 6. Decisions

- **D1 — Single-operator design, open-source runnable.** (2026-06-12) The Librarian is designed for one operator running their own fleet; it stays open source so others can run their own instance. Rationale: this keeps multi-tenant/enterprise governance out of scope (no audience for under-evaluation review cycles, master-key rotation, etc.) without burning the "others may run it" bridge — auth and encrypted settings stay because a deployed instance still faces the internet, but workflow machinery is sized for an operator who trusts themselves.
- **D2 — Skills die as a server concept.** (2026-06-12) Remove `list_skills`, `get_skill`, the skill store, and `vault/skills/`. Rationale: the catalog has been empty in production since launch (ADR 0006 decision #4), Hermes structurally cannot call the tools, the authoring UI was deferred indefinitely, and the feature rests on an unverified assumption about harness skill-loading that turned out false. Scope note: this kills *skills*; references are decided separately (Q8).
- **D3 — Carve down the existing codebase; no greenfield.** (2026-06-12) Keep the vault/corpus layer, hybrid index, handoff store, and intake spine; simplify by deletion under the existing test suite. Rationale: the audit found the debt is breadth (shell features, half-migrations, duplication), not foundation. A rewrite re-derives the best third of the codebase with new bugs.
- **D4 — Curator governance simplifies to git.** (2026-06-12) Drop the under-evaluation lifecycle and dry-run modes. Addendum edits apply immediately as git commits; `git revert` is the rollback. Keep the flag-review queue and proposal approval. Rationale: the evaluation loop is the most sophisticated *and* least tested machinery in the curator, sized for operators who distrust addendum edits — which D1 removes from scope. Git already provides versioning and rollback; the proposal/flag queues already provide the human-in-the-loop checkpoint that matters.
- **D5 — References survive as a first-class type, with the fixes.** (2026-06-12) Three information types: memories, handoffs, references. References get a persistent embedding cache (invalidated per file) and chunked indexing instead of ~2K-token truncation. Rationale: with skills dead (D2), references are the only channel for long-form admin-uploaded content, which was a founding requirement. Whether `search_references` stays a separate verb or becomes `recall(scope:)` is settled at the scenario walk.
- **D6 — One curator.** (2026-06-12) One operation vocabulary (create/update/merge/split/archive/noop), one validation + apply path (single force-propose router), one prompt core with job-specific sections. Intake = the curator invoked on one submission with navigate-gathered evidence; grooming = the curator invoked on a corpus slice. Entry points: on-submission, on-schedule, run-now. Rationale: the intake/grooming split duplicated ~60%-identical prompts (v4 vs v2 skew) and reimplemented force-propose routing twice with diverging semantics; D4 already deleted most of the gate-logic divergence.
- **D7 — Wholesale deletion confirmed.** (2026-06-12) Delete: classifier stub + `pendingClassification` routing, SQLite backend + env flag (markdown becomes the only backend), sessions dashboard remnants, inert `domain` field, ledger-throwing dashboard log/analytics paths (thin git-log reader or delete the views), dead `VerifyResult` exports. Close the three parked proposals explicitly (hybrid-recall ideas may be absorbed into D5's index work; the other two are dead). Rationale: all audit-confirmed dead, stubbed, or half-migrated; owner confirmed none are load-bearing.
- **D8 — Namespacing removed; one shared corpus.** (2026-06-12) The agent-private vs common namespace split is unused in practice — delete the namespaced index wrapper and its backlink-scoping rules. All memories are common. Rationale: owner confirmed the fleet runs one shared corpus; the namespacing machinery is real complexity guarding a boundary nobody uses. If a privacy boundary is ever needed, per-conversation private mode (in-conversation marker) already covers "don't store this," which is the actual use case observed.
- **D9 — Handoff/takeover/learn/private become primer protocols; slash commands are optional sugar.** (2026-06-12) The primer documents the protocols in natural language (e.g. "to hand off: write a document with these five sections, call store_handoff") so any harness can perform them without plugin code. Per-harness slash commands remain only where the harness makes them cheap, as thin prompt templates over the same protocols. Rationale: with conv_state gone the commands are pure prompt text; making the primer the canonical definition removes the five-way duplication of command prose and makes the system fully usable on harnesses with no command registration.
- **D10 — H7 committed: tiered integration, conv_state deleted, 7-verb surface, connect-time primer.** (2026-06-12) The primer is one ≤2KB operator-editable document served centrally, delivered via MCP `instructions` (Claude Code, Codex), OpenCode's remote-URL `instructions` config, Hermes `system_prompt_block()`, Pi `before_agent_start`. conv_state (3 tools + sidecar + per-turn plumbing) is deleted. Tool descriptions carry the standing "recall before answering / remember after learning" reminder since every harness re-renders them per request. Rationale: system-layer content survives compaction by construction (compaction summarizes conversation messages, not the prompt prefix) — it was the old per-turn user-message injection that compaction ate, forcing the re-injection workaround. Residual risk is salience in long contexts, mitigated by tool descriptions; monitor tool-usage analytics post-cutover and add a per-turn nudge only if evidence demands it (parking lot).
- **D11 — Private mode blocks writes only.** (2026-06-12) The in-conversation private marker means: no `remember`, `store_handoff`, or `flag_memory` until the user toggles back. `recall` and `search_references` stay allowed; the primer states plainly that read queries reach server logs. Rationale: the observed use case is "don't store this," not "sever the connection"; keeping recall preserves the system's usefulness during private stretches, and the single-operator context (D1) makes the logging trade explicit and acceptable.
- **D12 — `search_references` stays a separate verb; the surface is 7 verbs.** (2026-06-12) recall, remember, flag_memory, store_handoff, list_handoffs, claim_handoff, search_references. Rationale: references are deliberately *not* auto-recalled; a separate verb makes that contract self-documenting in the tool description, where a `scope` parameter would force recall's description to explain two retrieval behaviors.
- **D13 — One crisp auto-apply rule for the curator.** (2026-06-12) `create`/`update`/`merge`/`noop` operations auto-apply at confidence ≥ threshold (one configurable knob); `archive` and `split` always propose. The off/safe_only/high_confidence policy levels and the LLM-self-reported `risk_level` field are deleted. Rationale: the old "safe_only = risk_level==normal" rule trusted the model to assess its own risk; the new rule is enforced by operation type — the only two operations that destroy or restructure information are exactly the two that always get human review.
- **D14 — Surviving integrations move into the monorepo (`integrations/<harness>/`); the five external repos are archived.** (2026-06-12) Hermes adapter (Python), Pi extension (TS), Claude Code command sugar (markdown), OpenCode/Codex docs. The monorepo hosts the Claude marketplace manifest; the Pi extension publishes to npm from the workspace; the Hermes adapter installs by script. Rationale: post-D10 the cross-repo contract surface is too small to justify five-repo coordination; one PR, one changelog, co-located tests. Accepted costs: Python in the TS monorepo CI matrix; marketplace installs pull the whole repo (CI-pushed mirror is the escape hatch if ever needed).
- **D15 — Dashboard gains an Obsidian-lite vault explorer/editor.** (2026-06-12) File tree over the whole vault (memories, handoffs, references, `.curator/`, primer); rendered markdown with clickable wikilinks and a backlinks pane (link graph exists); raw editor with frontmatter validation on save; create/rename/delete with wikilink-integrity rewrites. All writes go through the store layer (git commit + index invalidation) — never raw file writes. The primer becomes `vault/primer.md` edited here (no bespoke primer editor). No graph view in v1. Rationale: "admins checkout the repo and use Obsidian" assumed a burden not every operator wants (the owner included); the dashboard becomes the complete admin surface, Obsidian the optional power path.
- **D16 — Git is server-owned, surfaced as history/diff/rollback in the dashboard.** (2026-06-12) Server guarantees the vault repo: init if absent, auto-commit per write, optional remote push (= backup, existing). Dashboard surfaces: per-file history with diffs and "restore this version" (implemented as a new revert commit — never history rewrite); whole-vault restore to a chosen commit, guarded by a confirmation, an automatic pre-restore tag, and pausing the curator during the operation. Index rebuilds from markdown afterwards by construction. This same surface IS the audit trail: curator commits (with provenance notes) render as the activity log, completing D7's "thin git-log reader" option and fully replacing the dead event ledger. Rationale: owner needs rollback without a git relationship; one surface serves history, diffs, rollback, and audit.

## 7. Loose ends / parking lot

- Reference embedding cache + chunking (D5 work item).
- Git-history consumer for dashboard logs/analytics, or delete those views (D7 allows either).
- Vault git history never scanned for secrets (tech-debt.md) — independent of this redesign, but worth a slot.
- Plugin-repo vs installed-plugin discrepancy (§2.3).
- Memory frontmatter field diet (priority/confidence/usefulness_score/conflicts_with/supersedes/aliases/applies_to — which ranking signals actually move recall quality?).
- Monitor recall/remember frequency post-cutover (dashboard analytics); add per-turn nudge in hook-capable harnesses only if usage sags (D10).
- Primer endpoint must be unauthenticated GET for OpenCode's remote-URL config (S3) — ensure the primer never contains operator-specific/secret content.
- Primer wording must avoid Hermes prompt-injection regex triggers (S4).
- Agent identity: with conv_state gone, `agent_id` is bearer-token- or self-reported per call — fine for single operator; revisit if multi-operator ever matters.

## 8. Sub-question deep-dives

### 8.1 Which harnesses honor MCP `instructions`? (resolved 2026-06-12, background research, primary sources)

| Harness | Injects `instructions`? | Where | Caveats |
|---|---|---|---|
| Claude Code | **Yes** | Model context at session start | Truncated at **2KB**/server; put critical text first |
| Codex CLI | **Yes** | As tool-*namespace* description (Responses API `type:"namespace"`; code-mode exec-tool description) | Rides the tool list, not system prompt; connector metadata overrides |
| OpenCode (anomalyco) | **No** — silently dropped | — | Feature requests closed `not_planned` (#30084) / stale (#7373). BUT: `opencode.json` `instructions` config accepts **remote URLs** → zero-code primer via `GET /primer.md`; plugin fallback `chat.system.transform` |
| Hermes (NousResearch/hermes-agent) | **No** — only `.capabilities` read | — | Native channel: `MemoryProvider.system_prompt_block()`. Runs prompt-injection regex screening over MCP content — primer wording matters |
| Pi (earendil-works) | **No — core has no MCP support at all** | — | MCP only via 3rd-party adapter (which also drops instructions). Native channel: extension `before_agent_start` → `{systemPrompt}` |

Key sources: code.claude.com/docs/en/mcp ("Only tool names and server instructions load at session start"; 2KB cap), openai/codex `codex-rs/codex-mcp/src/rmcp_client.rs` (`server_instructions` → namespace description), anomalyco/opencode `packages/opencode/src/mcp/index.ts` (zero `instructions` references), NousResearch/hermes-agent `tools/mcp_tool.py` + `agent/memory_provider.py`, Pi SDK (zero `mcp` references).

Design implication: a portable memory server cannot rely on `instructions` alone, but the per-harness shim shrinks to **one hook that injects one centrally-served string**, and the per-turn conv_state machinery is unnecessary everywhere. Duplicating the core "recall before answering / remember after learning" guidance into tool descriptions is the lowest common denominator every harness renders.

## 9. Scenario walks

Design under test: D1–D10. Verdicts: ✓ clean, ⚠ works with notes, ✗ gap.

- **S1 — Fresh Claude Code session, zero plugin.** Operator adds the MCP server; primer arrives via `instructions` (≤2KB, critical first sentence leading); tool descriptions carry per-verb protocol detail (e.g. `store_handoff`'s description holds the 5-section template, so the primer only needs "to hand off, call store_handoff"). Agent recalls before its first substantive answer. **✓** — with the explicit constraint that the primer draft must be written to a 2KB budget; detail lives in tool descriptions.
- **S2 — Codex session.** Primer arrives as the tool-namespace description; visible wherever the tool list is presented. Slightly weaker placement than system prompt, but the namespace text + per-tool descriptions cover behavior. **✓**
- **S3 — OpenCode, zero plugin.** `opencode.json` `instructions: ["https://<librarian>/primer.md"]` + standard MCP config for the 7 tools. **⚠** — requires the primer endpoint to be an unauthenticated GET (acceptable: the primer is generic guidance, not vault content; confirm nothing operator-specific leaks into it). Fallback if remote-URL fetch proves flaky: the existing `chat.system.transform` plugin shrinks to ~20 lines.
- **S4 — Hermes, full parity.** Provider returns **7** tool schemas from `get_tool_schemas()` (verified 2026-06-12 against `agent/memory_provider.py`: the ABC accepts an arbitrary list; the old 3-tool cap was the plugin's choice — the audit's "Hermes structurally cannot" claim is corrected). Primer via `system_prompt_block()`. Wording must avoid Hermes's prompt-injection regexes. **✓**
- **S5 — Pi.** Extension = `before_agent_start` (primer) + 7 thin tool proxies via `pi.registerTool` (Pi has no MCP). More than "one hook" but all mechanical. **✓**
- **S6 — Agent learns a lesson mid-task.** `remember` → inbox (fire-and-forget) → curator on-submission: navigate gathers evidence, judge says "augment existing memory X", apply path updates X, decision logged. **✓** (D6 single path)
- **S7 — "Extract lessons" in a command-less harness.** User says it in natural language; primer protocol (D9) tells the agent to review the conversation and call `remember` per durable lesson. **✓**
- **S8 — Cross-harness handoff + claim race.** Claude Code agent calls `store_handoff` (passing project_key/cwd from its own context — no conv_state needed); Pi agent `list_handoffs` → `claim_handoff`; concurrent second claimant gets 409 with claim details. **✓** (existing atomic claim)
- **S9 — Private mode mid-conversation.** User says "go private"; agent acknowledges the in-conversation marker. **⚠ semantics must be pinned in the primer** — proposal: private = no writes (`remember`, `store_handoff`, `flag_memory`); `recall`/`search_references` stay allowed (queries do reach server logs — acceptable for a single-operator instance, and the primer says so). Pending owner confirmation.
- **S10 — Admin uploads a 500KB paper; agent needs a mid-document fact.** Upload via dashboard → chunked indexing + persistent embedding cache (D5 work) → `search_references` returns the relevant section. **⚠** — verb question: keep `search_references` separate (self-documenting "background material, NOT auto-recalled") vs fold into `recall(scope:)`. Recommendation: keep separate; overloading recall muddies its contract for marginal surface savings. Pending owner confirmation.
- **S11 — Nightly groom merges two redundant memories.** Curator on-schedule, slice-based, input-hash skip unchanged slices. **⚠ auto-apply policy needs a crisp rule** (current "safe_only = risk_level==normal" is LLM-self-reported and vague) — proposal: `create/update/merge/noop` auto-apply at confidence ≥ threshold; `archive` and `split` always propose. One knob (threshold), one hard rule, no self-reported risk levels. Pending owner confirmation.
- **S12 — Agent flags a wrong memory.** `flag_memory(reason)` → soft demote in recall + dashboard review queue → admin archives or dismisses. **✓** (exists, survives unchanged)
- **S13 — Server down mid-session.** Tools fail at harness level; primer (already in context) says never block the user's work; agent proceeds without memory. **✓**
- **S14 — Compaction mid-session.** Primer is in the system layer; survives by construction (D10). Tool descriptions re-rendered every request. **✓**

No ✗. The three ⚠ details were resolved same-day: S9 → D11, S10 → D12, S11 → D13. S3's unauthenticated primer endpoint noted in parking lot.

## 10. Late-stage observations

### 10.1 The converged shape (for the spec to inherit)

One sentence: **a markdown+git vault of three note types (memories, handoffs, references), served to any harness over MCP as 7 verbs, kept healthy by one curator with one apply rule, taught to agents by one ≤2KB primer riding the thinnest native channel per harness.**

- **Vault (keep, unchanged):** Obsidian-flavoured markdown + git history; disposable hybrid index (keyword + vector + backlinks, RRF); deterministic frontmatter; wikilink integrity.
- **Types:** memories (curated atoms), handoffs (5-section narrative, claim-once), references (long-form, chunked + cached embeddings, not auto-recalled).
- **Agent surface:** recall, remember, flag_memory, store_handoff, list_handoffs, claim_handoff, search_references. Zero internal tools.
- **Curator:** one operation vocabulary (create/update/merge/split/archive/noop), one validate+apply path, one prompt core; triggers on-submission / on-schedule / run-now; auto-apply = confidence ≥ threshold for create/update/merge/noop, always-propose for archive/split; addendum = a git-committed ≤2KB file, revert = rollback; curator chat survives as the admin steering UX.
- **Integration:** Claude Code + Codex = MCP config only. OpenCode = MCP config + one instructions URL line. Hermes = MemoryProvider returning 7 schemas + system_prompt_block. Pi = extension with before_agent_start + 7 tool proxies. Slash commands optional sugar over primer protocols. All surviving adapters live in `integrations/<harness>/` in the monorepo (D14); external plugin repos archived.
- **Dashboard:** Obsidian-lite vault explorer/editor (D15: tree, rendered view + wikilinks + backlinks, validated raw edit, primer at `vault/primer.md`); history/diff/rollback surface doubling as the audit trail (D16); memory browser, proposal queue, flagged queue, curator config + chat + run history, reference upload, backups.
- **Git:** server-owned — auto-init, auto-commit, optional remote push; admins interact with version history only through the dashboard (D16).

### 10.2 Simplification pass — what the old machinery looks like beside the new shape

- **The five plugin repos mostly dissolve.** Claude and Codex plugin repos can be archived outright (their only job, conv-state injection, is deleted; optional slash-command sugar for Claude Code is a folder of markdown prompts, not a codebase). OpenCode's plugin likely reduces to documentation (two config lines). Hermes and Pi shrink to thin, mechanical adapters. The "five-peer implementations" coordination rule — and the ~1500 lines it governed — disappears as a category.
- **`@librarian/intake-eval` (853 lines):** built to evaluate the intake judge in isolation. With one unified curator prompt, it either generalizes into *the* curator eval harness (useful for addendum iteration) or it's dead weight. Decide at spec time; default keep-and-generalize since prompt regression safety is what lets a solo operator iterate confidently.
- **Estimated deletion footprint:** skills store + verbs, conv_state store + tools + 5 injection pipelines, namespaced index, classifier stub, SQLite backend + dual-path factory, under-evaluation/dry-run lifecycle + 3 of 6 curator entry points, sessions remnants, domain field, risk_level plumbing, one of two prompt stacks, one of two force-propose routers. Rough order: a quarter to a third of the 43k-line server plus most of the plugin estate — while the feature set an agent actually experiences gets *larger* in practice (Hermes gains handoffs + references; every harness gains protocol parity via the primer).
- **Process note:** every deletion above became visible only after the replacement was articulated — the audit alone flagged them as "debt," but the decisions that made them *deletable* were D9/D10 (primer as canonical protocol surface) and D13 (apply rule by operation type). Build the new thing, then look at the old in its light.

### 10.3 Status

Brainstorm complete (2026-06-12): §4 empty, §6 has D1–D16, §9 walked 14 scenarios with no ✗. Owner review added D14–D16 (monorepo consolidation, vault editor, server-owned git with diff/rollback). Ready for `spec-driven-development` to take over, with this doc as input. Suggested spec order: (1) server carve-down (D2/D7/D8/D13 deletions + D6 curator unification + D16 git ownership), (2) primer + integration cutover (D9/D10/D11) and monorepo consolidation (D14), (3) dashboard: vault editor + history/rollback (D15/D16), (4) references fix (D5), (5) external repo archival.

Live-instance evidence (2026-06-12, owner's local `~/the-librarian/data/`): vault is git-initialized with 123 memories, last commit same-day → markdown backend confirmed live. `librarian.sqlite` (7MB), `events.jsonl` (4.2MB), and root `memories.md` all frozen at 2026-06-02 (the v0.6.0 cutover) → archivable. `consolidation-runs.json` written same-day → still live despite the legacy name; rename/merge during carve-down. Also archivable: `data-seed/` (322MB) and `data-migration/` (347MB) — one-off migration-era working dirs with zero references in code/docs/scripts (`.gitignore` blankets `data-*/`); ~640MB of their bulk is two redundant copies of the 319MB embedding model. Each contains a `secret.key` — archive as sensitive. Check `~/librarian-seed/` for the same family.
