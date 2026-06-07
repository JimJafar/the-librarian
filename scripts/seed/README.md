# `scripts/seed` — seed / migration tool (maintainer-only)

A small, local, **maintainer-only** tool to bootstrap or re-seed a markdown vault
from an external source, grooming everything through the intake. It is
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
  - `<source>/extract/**.json` — portable memory records as JSON (optional), replayed via `--extract`
- **Derived vault** (`<dataDir>/vault`) — a rebuildable *artifact*. Anything here can be
  reproduced by re-running `import`.

References are **copied verbatim** (that namespace just reads files off disk).
Every memory — your `memories/**` docs *and* any `extract/**` JSON records —
is replayed through the **real `remember` endpoint in-process**, intake
**on**, **seed-first** (your curated docs first, DB memories merge onto them),
then the intake grooms the inbox (navigate → judge → file with
`[[wikilinks]]`). No manifest, no idempotency layer.

## Commands

```sh
# bootstrap / re-seed the vault (needs an intake LLM — flags or stored config)
node scripts/seed/import.mjs --source <source> --data-dir <vault-dataDir> [--extract <source>/extract] \
     --endpoint <openai-compatible-url> --model <id> --token <key>

# refine the curator prompt: wipe + rebuild from the same source, then score
node scripts/seed/import.mjs --source <source> --data-dir <vault-dataDir> --extract <source>/extract --wipe --yes
pnpm --filter @librarian/intake-eval exec intake-eval run --model <model>   # the scoring loop
```

- `import` needs an **intake LLM** to groom. Provide it EITHER directly via
  `--endpoint <url> --model <id> --token <key>` (or the `LIBRARIAN_SEED_LLM_{ENDPOINT,MODEL,TOKEN}`
  env vars), OR let it fall back to the **curator config stored in `--data-dir`'s settings**
  (what the dashboard writes — but only into that store, so the dashboard's data dir + backend
  must match `--data-dir`). The direct flags are simplest for a one-off and avoid the mismatch.
  A real run is a maintainer action.
- `--wipe` clears the **entire** derived vault (memories/references/inbox/index),
  including any live memories — so it requires `--yes`. It's for bootstrap +
  the prompt-refinement loop, not for topping up a live store.
- Re-running `import` without `--wipe` is safe: references never overwrite
  (add-new-only), and memories merge via the intake (it `noop`s duplicates)
  — though a plain re-run may accrue minor LLM-dedup noise, which is why `--wipe`
  is the clean-rebuild path.

## Tests

`test/seed-import.test.ts` (root `pnpm test` suite) drives the pure helpers and
`runSeedImport` end-to-end against a real markdown store with a **scripted**
intake — no network. The real-model groom is exercised by the maintainer,
not CI. **All test fixtures are synthetic; no personal seed data lives in this repo.**
