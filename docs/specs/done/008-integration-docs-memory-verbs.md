# Spec: Integration docs — memory verb shape

## Status

Drafted 2026-05-21. Single PR (I1).

## Objective

Propagate the V1.x memory model changes into the integration agent docs so agents primed by those docs actually call the new tools in the new shape. The Sessions side was updated end-to-end in S1.2; the Memory side was not — every harness's `AGENTS.md` / `CLAUDE.md` still describes the pre-V1.x tool surface.

**The gap.** After V1.x, memory has:

- A three-state model (`active | proposed | archived`) replacing the previous five-state model.
- `archive_memory` (renamed from `delete_memory`).
- `verify_memory` made **load-bearing**: after a `recall` returns hits, the agent is expected to feed back a usefulness verdict per hit (`useful` / `not_useful` / `outdated`). `outdated` archives the memory; `useful` / `not_useful` adjusts recall rank by ±3.

None of this is mentioned in any harness's agent-facing docs. Agents discover the tool surface at runtime via MCP, so the system isn't *broken* — but the guidance to actually call `verify_memory` is missing, and the V1.x work is wasted if no agent ever calls it.

**Success means:** an agent reading any of the five harness `AGENTS.md` / `CLAUDE.md` files comes away knowing (a) the three-state memory model, (b) that `verify_memory` should fire after every recall hit the agent uses, (c) the three verdict values and what each one does, (d) that `delete_memory` is gone — use `archive_memory`.

## Non-goals

- **Not changing any MCP tool, schema, or behaviour.** This is a docs-only spec. V1.x landed the surface; this propagates the guidance.
- **Not redesigning agent docs.** The existing structure (Session block + Memory block + Working principles) stays — we add a Memory three-state paragraph and tighten the post-recall guidance.
- **Not adding new healthcheck steps.** The healthcheck docs already cover session-tool surface assertions; adding `verify_memory` / `archive_memory` to the expected list is a one-line edit, not a redesign.
- **Not touching `skills/use-the-librarian/SKILL.md`.** That skill is loaded by the agent on demand and was already updated as part of V1.x. The gap is specifically in the harness-level priming docs.
- **Not removing `propose_memory` / `remember` guidance.** Those tools are unchanged and the existing text still applies.

## Decisions (resolved)

- **One PR per the whole sweep.** Five harnesses × ~2 file edits each + healthchecks + READMEs = ~12–15 file edits. Cohesive enough to land as a single PR; small enough that splitting would just add review overhead.
- **Mirror the Session three-state paragraph.** Each harness's agent doc already has a Session three-state paragraph (`active | paused | ended`). The Memory equivalent (`active | proposed | archived`) sits directly underneath, in the same shape, so the parallel reads obviously.
- **Recall → verify guidance lives in "Working principles", not in the tool list.** The tool list enumerates *what exists*; the guidance section says *when to use it*. `verify_memory` is enumerated in the former and described in the latter.
- **No "retired tool" callout for `delete_memory`.** Unlike sessions (where the retired-verb migration notes serve users transitioning from the old slash commands), `delete_memory` was MCP-only and agents discover tools at runtime — the rename just needs to land in the current tool list without ceremony.

## Files to touch

| Harness | Primary edit | Secondary |
|---|---|---|
| `integrations/claude-code/` | `CLAUDE.md` | `healthcheck.md` (expected memory tools), `README.md` (tool list snippet) |
| `integrations/codex/` | `AGENTS.md` | `healthcheck.md`, `README.md` |
| `integrations/opencode/` | `AGENTS.md` | `healthcheck.md`, `README.md` |
| `integrations/hermes/` | `AGENTS.append.md` | `README.md` (no healthcheck file beyond the one in `integrations/`) |
| `integrations/pi/` | `AGENTS.md` | `README.md` |

Plus:

- `integrations/README.md` — top-level tool surface table if it exists.
- `docs/slash-commands.md` — memory tool surface row, if currently present.

## The text to land

### Memory three-state paragraph (mirrors the Session paragraph)

To paste under each existing Session three-state block:

> Memories are in one of three states: `active`, `proposed`, or `archived`. `active` is the recall pool; `proposed` is awaiting human approval (auto-routed for protected categories like identity and relationship); `archived` is the soft-deleted bucket. The retired verbs `delete_memory`, `confirm_memory`, `reject_memory`, and the conflict-resolution surface were removed when the three-state model landed — `archive_memory` covers deletion, proposals are accepted or rejected through the dashboard or `update_memory`, and conflict detection is gone.

### Verify-after-recall guidance

To paste in the "Working principles" / similar section of each agent doc:

> When `recall` returns hits and you use one, call `verify_memory` afterwards with a usefulness verdict so the store learns:
>
> - `useful` — the hit was load-bearing for the answer. Boosts recall rank by 3.
> - `not_useful` — the hit was a distractor or stale framing. Drops recall rank by 3.
> - `outdated` — the memory is factually wrong now. Archives it.
>
> The verdict is a single MCP call; don't skip it because the recall already gave you the answer. The whole memory-quality loop depends on these signals.

### Tool list updates

Wherever the per-harness doc enumerates memory tools (each `AGENTS.md`-style doc has one), the line is:

> The full memory tool surface (`start_context`, `recall`, `remember`, `propose_memory`, `update_memory`, `verify_memory`, `archive_memory`) is available alongside the session tools.

Specifically: `verify_memory` and `archive_memory` are added; `delete_memory` is removed if it appears in the existing list.

### Healthcheck assertions

Each `healthcheck.md` that currently asserts the session tool list also gets a one-line addition under the memory section:

> Expected memory tools: `start_context`, `recall`, `remember`, `propose_memory`, `update_memory`, `verify_memory`, `archive_memory`. The retired tools `delete_memory`, `confirm_memory`, `reject_memory`, `resolve_conflict` should NOT be in the list.

## Tests

- **`pnpm run check:storage-fixture`** — unaffected (no schema change).
- **Healthcheck script** (`pnpm run healthcheck`) — already enumerates the MCP tool surface against the server; assertion list updated to require `verify_memory` + `archive_memory` present and the four retired tools absent. This catches drift if a future PR re-introduces a retired tool by accident.
- **Manual stranger test:** open a fresh Claude Code session against the canonical instance, ask the agent to recall something it should remember about you, and watch whether it follows up with `verify_memory`. If it doesn't, the priming text didn't land. Repeat for each harness's agent doc.

## Acceptance

- `rg "delete_memory|confirm_memory|reject_memory|resolve_conflict" integrations/` returns zero hits.
- `rg "verify_memory" integrations/` returns at least one hit in each of the five harness directories.
- The healthcheck assertion list explicitly enumerates the V1.x memory tool surface.
- Stranger test: an agent primed by any of the five harness docs calls `verify_memory` after using a recall hit, without further prompting.

## Open questions

- **Should the verify-after-recall guidance be a "Working principle" or a more prominent callout?** I'd lean the principle section — agents that read priming docs read them whole — but if the stranger test fails it might need to be promoted to a bolded one-liner at the top of the memory block.
- **Cross-harness contract file (`docs/slash-commands.md`).** Currently session-focused; the V2 memory verbs aren't slash commands so they don't naturally belong there. Probably skip unless a memory-related slash surface is added later.
