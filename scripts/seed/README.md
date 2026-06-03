# `scripts/seed` — seed / migration tool (maintainer-only)

A small, local, **maintainer-only** tool to bootstrap or re-seed a markdown vault
from an external source, grooming everything through the consolidator. It is
**not** a product feature and **not** exposed over HTTP/MCP — general users add
content via Obsidian/the filesystem (references) or the dashboard, and the vault
file-manager (plan-036 F10) is the eventual UI for that. (This supersedes the
withdrawn spec 038, which over-specified a CLI feature we decided not to build.)

## Model

Two layers, deliberately:

- **Raw source** (external, immutable, git-tracked *by you* — **never** in this repo):
  - `<source>/memories/**.md` — hand-authored context/identity docs → **memories**
  - `<source>/references/**.md` — background/research docs → **references** (verbatim)
  - `<source>/skills/**` — (later) → the skills namespace
  - `<source>/extract/**.json` — an exported dump of an old SQLite store (see `extract`)
- **Derived vault** (`<dataDir>/vault`) — a rebuildable *artifact*. Anything here can be
  reproduced by re-running `import`.

References are **copied verbatim** (that namespace just reads files off disk).
Every memory — your `memories/**` docs *and* the SQLite `extract/**` records —
is replayed through the **real `remember` endpoint in-process**, consolidator
**on**, **seed-first** (your curated docs first, DB memories merge onto them),
then the consolidator grooms the inbox (navigate → judge → file with
`[[wikilinks]]`). No manifest, no idempotency layer.

## Commands

```sh
# 1. (migration only) dump an old SQLite store's ACTIVE memories → extract JSON
node scripts/seed/extract.mjs --db <old-sqlite-dataDir> --out <source>/extract

# 2. bootstrap / re-seed the vault (needs the curator LLM configured)
node scripts/seed/import.mjs --source <source> --data-dir <vault-dataDir> [--extract <source>/extract]

# refine the curator prompt: wipe + rebuild from the same source, then score
node scripts/seed/import.mjs --source <source> --data-dir <vault-dataDir> --extract <source>/extract --wipe --yes
pnpm --filter @librarian/consolidator-eval exec consolidator-eval run --model <model>   # the scoring loop
```

- `import` needs the **curator LLM** configured in the store (endpoint/model/token) —
  it reuses the curator's brain to groom. A real run is a maintainer action.
- `--wipe` clears the **entire** derived vault (memories/references/inbox/index),
  including any live memories — so it requires `--yes`. It's for bootstrap +
  the prompt-refinement loop, not for topping up a live store.
- Re-running `import` without `--wipe` is safe: references never overwrite
  (add-new-only), and memories merge via the consolidator (it `noop`s duplicates)
  — though a plain re-run may accrue minor LLM-dedup noise, which is why `--wipe`
  is the clean-rebuild path.

## Tests

`test/seed-import.test.ts` (root `pnpm test` suite) drives the pure helpers and
`runSeedImport` end-to-end against a real markdown store with a **scripted**
consolidator — no network. The real-model groom is exercised by the maintainer,
not CI. **All test fixtures are synthetic; no personal seed data lives in this repo.**
