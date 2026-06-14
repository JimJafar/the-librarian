# The Librarian

[![CI](https://github.com/JimJafar/the-librarian/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/JimJafar/the-librarian/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**The Librarian is a living, markdown-native knowledge graph for AI agents — with
a resident curator that tends it.** It is a markdown+git vault of three note
types — **memories**, **handoffs**, and **references** — linked into a graph by
`[[wikilinks]]`; a resident "librarian" curates the collection as it grows,
filing each new memory where it belongs, linking it to its neighbours, and
organising the whole for *retrieval*, not just storage. It's all plain files you
can read, edit, and reorganise yourself (in the dashboard or in Obsidian); git
gives it history; nothing is locked in a database.

Practically, that makes it a portable **memory + handoff layer for AI agents**:
served to any harness over MCP as **7 verbs**, taught to agents by one ≤2KB
**primer**, with an explicit **cross-harness handoff surface** so work started
in one harness (Claude Code, Codex, Hermes, OpenCode, Pi) can be packaged into a
single document and picked up cleanly in another.

It runs as a small self-hosted server, reachable locally or over the network.

## Self-host in one command

The `librarian` CLI's `server` command group stands up the server for you — it
builds and runs the all-in-one container, surfaces the master key once, and hands
you the MCP URL + agent token to paste into clients:

```sh
npm i -g @the-librarian/cli
librarian server up
```

`server up`/`update`/`down`/`status`/`logs`, Linux boot persistence
(`enable-boot`), and host-side admin (`server admin backup|restore|auth|rebuild`)
are all covered in the
[one-command self-host guide](./DEPLOYMENT.md#one-command-self-host-librarian-server).

## Install on any harness

Once your server is running, the `librarian` CLI wires The Librarian into your
harnesses and keeps them up to date — the package-manager-style tool you keep.
Any harness already has Node, so installing is two commands:

```sh
npm i -g @the-librarian/cli
librarian install
```

See [`packages/installer-cli`](./packages/installer-cli/README.md) for the
full command reference and what it writes to your environment.

## Harness integrations

Run the server, then add one config block per harness. Claude Code, Codex, and
OpenCode need **no plugin code at all** — the MCP config (plus, for OpenCode,
one `instructions` line pointing at the server's `GET /primer.md`) is a full
integration. Hermes and Pi get thin in-tree adapters. Each harness's exact
config and install steps live in its README:

| Harness | Integration | Shape |
|---|---|---|
| Claude Code | [`integrations/claude`](./integrations/claude) | MCP config; optional plugin adds 4 slash commands |
| Codex | [`integrations/codex`](./integrations/codex) | MCP config block in `~/.codex/config.toml` — no code |
| OpenCode | [`integrations/opencode`](./integrations/opencode) | MCP config + one remote-URL `instructions` line — no code |
| Hermes | [`integrations/hermes`](./integrations/hermes) | Python MemoryProvider (stdlib-only) proxying the 7 verbs |
| Pi | [`integrations/pi`](./integrations/pi) | Pi extension: primer hook + 7 native tool proxies |

All five teach the model the same protocols: the primer rides each harness's
thinnest native channel (MCP `instructions` where honored, a one-hook adapter
where not), and the 7 tools carry protocol-bearing descriptions that render in
every harness.

## Features

- **Durable memory** — `recall` / `remember` / `flag_memory` over one shared,
  curated corpus with project-key scoping and a three-state
  (`active` / `proposed` / `archived`) model.
- **Cross-harness handoffs** — `store_handoff` packages the work in a
  five-section document; `claim_handoff` claims it atomically in another
  agent / harness.
- **References** — long-form background material (specs, papers, manuals)
  uploaded by the admin, chunk-indexed with persistently cached embeddings so a
  500KB document is searchable end-to-end via `search_references` — deliberately
  *not* auto-recalled.
- **Memory curator** — one curator, one prompt core, one apply rule: routine
  operations (`create`/`update`/`merge`) auto-apply above a single confidence
  threshold; destructive ones (`archive`/`split`) always become human-reviewed
  proposals.
- **Dashboard as the complete admin surface** — memory browser, proposal +
  flag queues, curator config/chat/run history, **vault explorer/editor**
  (Obsidian-lite: tree, rendered markdown, wikilinks, backlinks, validated
  editing), and **history/diff/rollback** backed by the server-owned git repo —
  operators never need git or Obsidian.

Markdown-native and dependency-light: memories are plain `[[wikilinked]]` notes
in a git-backed vault, recall runs over a disposable in-memory index (keyword +
vector + backlinks, RRF-fused) rebuilt from the vault — no external database to
run.

## Quick start

### Docker (recommended for a VPS)

```sh
cp .env.example .env   # optional — auth/secret vars auto-generate
docker compose --env-file .env -f docker/docker-compose.yml up -d --build
```

A fresh install needs **zero** auth/secret env vars: `LIBRARIAN_ADMIN_TOKEN` and
`LIBRARIAN_SECRET_KEY` auto-generate on first boot (watch the log for the
one-time values), and you enable owner login from the dashboard. Full deploy
guide: [DEPLOYMENT.md](./DEPLOYMENT.md).

Then connect a harness: pick yours under [`integrations/`](./integrations) and
add the config block from its README.

### Local dev (two services)

Requirements: **Node 22.5+** and **pnpm 9.15.x** via Corepack:

```sh
corepack enable && corepack prepare pnpm@9.15.0 --activate
pnpm install
pnpm run seed                               # seed sample memories
pnpm run serve                              # mcp-server at http://127.0.0.1:3838
pnpm --filter @librarian/dashboard dev      # dashboard at http://127.0.0.1:3000
```

```sh
pnpm run healthcheck                              # local end-to-end smoke
pnpm run healthcheck -- --remote http://host:3838 # probe a deployed instance
```

## Configuration

Auth and secrets are managed from the dashboard at **`/settings/auth`** (password
and/or GitHub/Google), enforced without a redeploy. Agent tokens are
dashboard-managed too. A fresh install needs **zero** auth/secret env vars;
`LIBRARIAN_ADMIN_TOKEN` and `LIBRARIAN_SECRET_KEY` auto-generate on first boot.

For the host/port, data dir, and the legacy env-configured auth path, see
[DEPLOYMENT.md](./DEPLOYMENT.md).

## MCP tools — the 7-verb agent surface

Agents talk to the Librarian over `/mcp` with a bearer token. The surface is
exactly seven tools — contract-tested, with zero internal tools:

### Memory

- `recall` — hybrid search over memories (`active` only by default; pass
  `include_ids: true` for `[mem_…]`-prefixed lines so callers can flag).
- `remember` — fire-and-forget: each submission lands in the curator's intake
  inbox; the curator dedupes, merges, and files it asynchronously.
- `flag_memory` — flag a memory as wrong / misleading / outdated with a
  free-text reason; routes it to review (and soft-demotes it in recall) rather
  than archiving unilaterally.

Memories are `active`, `proposed`, or `archived`. Admin/curatorial ops
(archive, approve, update, list proposals) are **not** agent MCP tools — they
live on the dashboard tRPC surface (ADR 0006).

### Handoffs

- `store_handoff` — store a handoff document (five required headings: *Start &
  intent*, *Journey*, *Current state*, *What's left*, *Open questions*).
- `list_handoffs` — list handoffs in the current project / cwd.
- `claim_handoff` — atomically claim a handoff by id. Claiming is one-shot —
  once claimed, the handoff is closed to other callers.

### References

- `search_references` — search the long-form reference corpus. A separate verb
  by design: references are background material, never auto-recalled.

## Teaching the agent — the primer

The teaching surface is the **primer** — one ≤2KB operator-editable document at
`vault/primer.md`, served at connect time as the MCP `initialize`
`instructions` field and at the unauthenticated `GET /primer.md` endpoint —
plus each tool's own protocol-bearing description. The primer carries the
recall/remember loop, the handoff/takeover and learn protocols, private mode,
and the fail-soft rule ("never block the user's work if the server is
unreachable"). Edit it from the dashboard's Vault page; the server enforces the
2KB cap on save. See
[`docs/adr/0007-the-rethink.md`](./docs/adr/0007-the-rethink.md) for the design.

### Slash commands (optional sugar)

`/handoff`, `/takeover`, `/learn`, and the local-only `/toggle-private` are
thin prompt templates over the primer protocols — nothing is lost on a harness
that only has the MCP config; saying "hand this off" or "go private" in plain
language works identically. The contract is in
[`docs/slash-commands.md`](./docs/slash-commands.md).

**Private mode** (`/toggle-private`, or just "go private") is an
in-conversation marker, not server state: while on, the agent makes no writes
(`remember`, `store_handoff`, `flag_memory`); `recall` / `search_references`
stay available, and those read queries do reach the server's logs.

## Dashboard

The Next.js admin cockpit (port `3000`) surfaces **Memories**, **Handoffs**,
**Analytics**, **Proposals**, **Flagged**, **Archive**, the **Curator** cockpit,
the **Vault** explorer, **Backups**, **Tokens**, and **Settings** — reachable
from a persistent top nav and a ⌘K command palette (`?` shows shortcuts). Owner
login is configured from **Settings → Auth**; the admin token never reaches the
browser.

The **Vault** page is the Obsidian-lite admin surface: a tree over the whole
vault (memories, handoffs, references, `.curator/` addendums, `primer.md`),
rendered markdown with clickable wikilinks and a backlinks pane, and raw
editing with frontmatter validation on save — every save lands as a git commit
through the store layer. Per-file **history** shows the commit list and diffs
with "Restore this version" (a new revert commit — history is never
rewritten); the **Activity** feed shows every vault commit with curator
provenance and offers a guarded whole-vault restore (confirmation → curator
pause → pre-restore tag → revert commit).

## CLI

The `the-librarian` binary runs `rebuild`, `seed`, `backup` (push the vault to
the configured GitHub remote), `export`, `auth`, `handoffs`, and
`migrate-data-dir` (upgrade a pre-1.0 data dir: renames legacy bookkeeping,
strips retired frontmatter fields and settings keys, and *reports* — never
deletes — legacy artifacts):

```sh
the-librarian handoffs list --project the-librarian
the-librarian handoffs show hof_…
the-librarian handoffs purge hof_… --admin

the-librarian auth status                              # configured methods (no secrets)
the-librarian auth reset-password                      # set a new owner password
the-librarian auth disable                             # break-glass: turn enforcement off
```

Every handoff verb supports `--json`, `--agent <id>`, `--admin`, and the
project / cwd / harness scope flags.

## Memory curator

One curator engine with one versioned prompt core does two jobs, configured
and observed from the dashboard **Curator** cockpit (`/curator`) with parallel
**Intake** and **Grooming** sections (shared LLM provider management above
both):

- **Intake** consolidates each new submission as it lands in the inbox —
  gather evidence around it, then create / update / merge against the existing
  corpus.
- **Grooming** tends the existing corpus slice by slice (dedupe, archive
  stale, refine). Grooming is **triggered, not scheduled**: it runs from the
  dashboard's *Run now* and automatically after an intake sweep pushes enough
  new material past `curator.grooming.trigger_threshold` (rate-limited by
  `curator.grooming.debounce_minutes`).

**One apply rule** (ADR 0007): `create` / `update` / `merge` operations
auto-apply when the curator's confidence clears the single
`curator.apply.confidence_threshold` knob (default **0.8**); `archive` and
`split` — the only operations that destroy or restructure information —
**always** become proposals for human review, as does any operation touching a
`requires_approval` memory. Each job is enabled independently from the
dashboard (`curator.intake.enabled` / `curator.grooming.enabled`). The
curator's LLM API token is encrypted at rest with `LIBRARIAN_SECRET_KEY`.

### Tuning the curator — the self-improving loop

The curator improves through use. An admin teaches each job by editing its
**prompt addendum**, watches the results on real memories, and either keeps the
change or reverts it. Everything below is **admin-only** — there is no
agent-facing surface, and `recall` / navigate are untouched.

**Per-job addendum files (git-versioned).** Each job's prompt addendum is a
committed vault file — `<vault>/.curator/intake-addendum.md` and
`grooming-addendum.md` — appended to that job's prompt as **advisory**
guidance. Because it lives in git you get diff, revert, and backup for free.

**Edits apply immediately; git is the rollback.** Editing an addendum (from
the dashboard editor or the chat) commits the file and the job's next run
reads the new text — there is no evaluation gate. If an edit turns out badly,
restore the prior version from the file's history in the Vault page (a new,
revertable commit).

**Curator chat.** A dashboard chat — a **"discuss this memory"** entry on each
memory row plus a **general** entry — grounds the conversation in the memory and
its decision history. It can **propose** a fix-now mutation (merge / split /
update / **unmerge**) or an addendum edit, and the admin **confirms** each with an
explicit button: the curator proposes, it never executes against the live store
on its own (human-in-the-loop). A co-authored addendum over **2 KB** triggers a
soft **condense** turn (rewrite tighter, preserving load-bearing rules) rather
than failing; the file write hard-rejects anything over 2 KB as a backstop.

**How it's kept safe — the admin judges real results.** The addendum is
**advisory only**: the curator's hard, safety, and structural rules stay
**code-re-checked regardless of what the addendum says**, so an addendum can
shape judgement but never override an invariant. The guards are deliberately
simple and human-centred:

1. **Code re-check** of the hard/safety/structural rules on every operation,
   independent of the addendum.
2. The **2 KB cap** (soft condense + hard write backstop) keeps an addendum from
   growing into an unbounded second prompt.
3. **Git-versioned addendums** — every edit is a commit; a bad edit is one
   restore away, and the proposals it produced are reviewable in the queue.

You read the actual proposals the change produced and decide; the loop is tuned
by a human judging real results, not by a metric.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the workspace layout, "where to
add what" recipes (new MCP tool / tRPC procedure / dashboard page / CLI verb),
and local test/lint commands.

Architecture decisions live in [`docs/adr/`](./docs/adr/); the active spec and
backlog live in [`docs/`](./docs/).

## License

Apache-2.0.
