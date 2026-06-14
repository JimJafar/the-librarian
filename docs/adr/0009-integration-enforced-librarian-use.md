# ADR 0009 — Ship enforcement, not just advice: integration guardrails that redirect file-writes to the Librarian

- **Status:** Proposed
- **Date:** 2026-06-14
- **Related:** ADR 0006 (agent-facing MCP surface), ADR 0007 (the rethink — the
  primer as canonical teaching surface, D9; private mode, D11; in-tree
  integrations, D14). Builds on the primer; does **not** change the 7-verb
  surface, the protocols, or the memory state model.

## Context

The Librarian's whole value proposition is that it is **the** memory + handoff
layer — the default an agent reaches for on any harness, any machine, instead of
scribbling a file or using a harness's built-in note store. The teaching surface
that's meant to make that happen is the **primer** (ADR 0007 D9): served as the
MCP `initialize` `instructions` field and at `GET /primer.md`, plus each tool's
protocol-bearing description. It says, in the connect-time instructions, *"If you
have a different built in memory system, you must use the librarian instead."*

**That advice does not reliably change agent behavior.** The evidence is our own:
across three months of building this, agents — including the ones building it —
default to files. In a single recent session, an agent asked to "write a handoff
for a fresh session" wrote a flat `HANDOFF.md` into the repo **and** routed a
durable lesson into the local Claude Code file-memory store, with the *"you must
use the librarian instead"* instruction sitting in its context the entire time.
It only used `store_handoff`/`remember` after the human asked, twice, *"why aren't
you using the librarian?"* The mandate was present, injected, and ignored.

The failure is structural, not attitudinal, and adding more advice won't fix it:

1. **Advice competes with ingrained defaults and loses under load.** "Write a
   file" is a single, always-available, zero-dependency action; using the
   Librarian requires recalling the right verb and trusting the server is up.
   Another sentence in the primer is the same kind of lever that already failed.
2. **The MCP server cannot enforce client behavior.** It only ever sees MCP
   calls. It has no visibility into, and no veto over, a `Write` the harness
   performs. A purely server-side fix that makes an agent *unable* to write
   `HANDOFF.md` is not physically possible — the enforcement point isn't the
   server.
3. **The only enforcement point is the harness boundary** — a pre-action hook
   the harness runs regardless of what the model decides. And the Librarian
   already owns a per-harness layer: the in-tree `integrations/<harness>/`
   (ADR 0007 D14), distributed and kept current by `librarian install`. Today
   those integrations ship only *advisory* surfaces (MCP config, the primer, the
   slash commands). They ship **no enforcement**.

So the gap is concrete: the place that *can* enforce (the integration) ships only
advice, and advice has been empirically shown insufficient — by us, on our own
product.

## Decision

**The Librarian's harness integrations ship enforcement, not just advice.** Each
integration gains a **guardrail** that intercepts file-writes shaped like a
handoff or a durable memory and steers the agent to `store_handoff` / `remember`
instead — authored once in this repo, version-controlled, and distributed to
every harness on every machine by `librarian install`. Specifically:

1. **Where the harness supports a pre-action veto, the guard is authoritative.**
   In Claude Code that is a `PreToolUse` hook on `Write`/`Edit`: a write of a
   handoff/memory-shaped file is **denied**, with a teaching message naming the
   verb to use instead. This is the reference implementation and the one that
   would have prevented the triggering incident outright.
2. **Where a harness has no pre-action veto, ship the strongest nudge it does
   support** — and **say so honestly**. We publish a per-harness capability
   matrix; no integration claims enforcement it doesn't have. "Enforced
   everywhere we can, nudged everywhere we can't" beats a uniform fiction.
3. **It lives in the Librarian, not on a machine.** The guard is part of each
   integration and is installed/updated by the CLI like everything else. The
   installed artifact does land on each machine — that is unavoidable, because
   the block happens at the harness boundary — but its source of truth,
   versioning, and distribution are the Librarian. That is the difference
   between this and a bespoke hook a user hand-rolls on one box.
4. **It obeys the existing sacred rules.** The guard is **fail-soft** (AGENTS.md):
   if the guard itself errors, the user's tool call proceeds — it never blocks a
   turn or crashes a hook. It honors **private mode** (ADR 0007 D11): it never
   silently converts a suppressed file-write into server state. And it is a
   **shared cross-harness contract** — changed across every `integrations/*` and
   documented together, never in one harness unilaterally.

This does **not** touch the 7-verb MCP surface, the handoff/takeover/learn/
private-mode protocols, the memory state model, or the primer's role as canonical
teaching. The primer stays — it's necessary. The guardrail is the enforcement the
primer can't be.

## Consequences

**Positive**

- The behavior the product depends on stops depending on agent discretion. On
  harnesses with a veto, "use the Librarian" becomes the path of *only*
  resistance for handoffs/memories, not the path of least resistance.
- The fix is a Librarian feature, shipped and updated through `librarian install`
  — it propagates to every harness and machine by construction, which is exactly
  the property a per-machine hook lacks.
- It dogfoods the product's own thesis: the system that curates an agent's memory
  also makes the agent actually use it.

**Negative / costs**

- **Not uniform across harnesses.** Airtight where a pre-action veto exists
  (Claude Code, likely Pi); nudge-only where it doesn't (Codex/OpenCode are
  "config + instructions, no code"; Hermes' adapter can't veto arbitrary host
  file-writes). We ship honesty over the appearance of uniformity, and the exact
  per-harness primitive is a discovery task in the spec.
- **False-positive risk.** A guard that blocks file-writes can block a
  *legitimate* one (a real handoff template in `docs/`, a `memory/` source
  directory in some other project). The matcher must be conservative,
  allowlist-aware, and carry a deliberate escape hatch; getting this wrong makes
  the guard infuriating, which gets it disabled, which is worse than nothing.
- **Fail-open is a real tension.** Fail-soft means a buggy guard silently stops
  enforcing rather than blocking the user — correct per doctrine, but it means
  enforcement quietly degrades on guard error. We accept this and log to the
  sidecar.
- **Maintenance surface.** A guard per integration, plus per-harness hook
  plumbing, plus the match patterns, is new code to own across five surfaces and
  to keep behind the drift-guard discipline.

**Threat model (explicit):** this targets the *accidental-default* failure — a
cooperating agent that means well and reaches for a file out of habit. It is
**not** an adversarial control: an agent that wants to evade it can (write to an
unmatched path, disable the hook). That's fine; the goal is to make the right
thing the default and the wrong thing require intent, not to defeat a hostile
client.

## Alternatives considered

- **Sharpen the primer / add a SessionStart reminder (more advice).** Rejected:
  this is the layer that already failed. The mandate is already injected every
  session and was ignored; another injected sentence is the same failed lever.
- **Enforce server-side.** Rejected as impossible: the MCP server sees only MCP
  calls and cannot observe or veto a harness file-write. There is no server-only
  fix.
- **A user-authored hook in `~/.claude` (per machine).** Rejected by the owner:
  it doesn't propagate across machines or harnesses, and it's the opposite of
  "fixed in the Librarian." The enforcement must ship *with the product*.
- **Detect-after-the-fact (PostToolUse): notice a written `HANDOFF.md` and
  auto-ingest it.** Weaker and considered as a *fallback* for harnesses without a
  pre-action veto, not the primary design — it can't prevent the file, only
  react, and reacting reliably is itself a nudge.
- **Make the verbs so frictionless that files aren't tempting (UX only).** Worth
  doing regardless, but it doesn't *prevent* the lapse; ease reduces temptation,
  it doesn't remove discretion. Complementary, not a substitute.
