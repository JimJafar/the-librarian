# The Librarian — Pi extension

A [Pi](https://pi.dev) package that gives the Pi coding agent durable memory and
cross-harness handoffs, backed by a remote
[Librarian](https://github.com/JimJafar/the-librarian) MCP server.

Pi's core has **no MCP support**, so this extension does the wiring itself: it
registers the Librarian's 7 agent verbs as native Pi tools (each one a thin,
fail-soft proxy over the server's stateless `/mcp` endpoint) and injects the
Librarian primer into the system prompt. One install, zero config files.

## What you get

- **7 tools, identical to every other harness** — `recall`, `remember`,
  `flag_memory`, `store_handoff`, `list_handoffs`, `claim_handoff`,
  `search_references`. Descriptions and schemas mirror the server's
  (a drift-guard test pins them), so the model is taught the same protocol in
  Pi as in Claude Code, Codex, OpenCode, and Hermes.
- **Primer injection** — the operator-editable `vault/primer.md` (≤2KB) is
  fetched once per process from `GET <server>/primer.md` and appended to the
  system prompt via `before_agent_start`.
- **Four slash commands** (optional sugar): `/handoff`, `/takeover`, `/learn`,
  `/toggle-private` — thin prompt templates that drive the corresponding tool
  flows. See [`docs/slash-commands.md`](../../docs/slash-commands.md).
- **Fail-soft everywhere** — if the Librarian is down, tools return a short
  error string (never a thrown harness error), the primer is skipped, and the
  user's turn is never blocked.

## Install

From npm (once published — see "Publishing" below):

```sh
pi install npm:the-librarian-pi-extension
```

From source (works today):

```sh
git clone https://github.com/JimJafar/the-librarian
pi install /path/to/the-librarian/integrations/pi
```

(`pi install git:…` of the monorepo root won't work — the package lives in the
`integrations/pi` subdirectory, so install from a local clone path.)

## Configure

Set two environment variables in the shell that launches `pi`:

| Variable | Meaning |
| --- | --- |
| `LIBRARIAN_MCP_URL` | The server's MCP endpoint, e.g. `https://your-librarian/mcp` |
| `LIBRARIAN_AGENT_TOKEN` | A per-agent bearer token issued by your Librarian |
| `LIBRARIAN_TIMEOUT_MS` | *(optional)* per-call timeout, default `15000` |

Without both required variables the extension stays **dormant**: no tools, no
network calls — only the four slash commands register, and they explain what's
missing.

Security posture (inherited from the security-reviewed clients in this family):
the bearer token travels only in the `Authorization` header, redirects are
refused so a 3xx can't carry the token cross-origin, the endpoint scheme is
allowlisted to http(s), and response bodies are size-capped.

## Develop

This package is part of the `the-librarian` pnpm workspace:

```sh
pnpm install
pnpm --filter the-librarian-pi-extension test        # vitest
pnpm --filter the-librarian-pi-extension typecheck   # tsc --noEmit
```

The schema-parity suite imports the compiled `@librarian/mcp-server`, which is
built automatically on `pnpm install` (its `prepare` script).

## Publishing

The package is publishable (`"private": false`) and carries the `pi-package`
keyword, so `npm publish` from `integrations/pi/` both releases it and lists it
in Pi's gallery at `pi.dev/packages`. **Publishing is a repo-owner action** —
it is deliberately not part of any automated flow here. Until it's published,
use the "from source" install above.
