# Integrations

All five harnesses (Claude Code, Codex, Hermes, OpenCode, Pi) now ship as
standalone, installable plugins in their own repos. This directory holds
the shared lifecycle helper consumed by the Claude Code in-tree
integration — and a placeholder for that's-it.

## Standalone plugins (separate repos)

- **Claude Code** — [`the-librarian-claude-plugin`](https://github.com/JimJafar/the-librarian-claude-plugin) (marketplace-installable; bundles the lifecycle hooks, `/lib-session-*` commands, `.mcp.json`, and the `use-the-librarian` skill).
- **Codex** — [`the-librarian-codex-plugin`](https://github.com/JimJafar/the-librarian-codex-plugin) (Codex plugin marketplace; bundles the four lifecycle hooks, `.mcp.json`, and an `@librarian` umbrella skill).
- **Hermes** — [`the-librarian-hermes-plugin`](https://github.com/JimJafar/the-librarian-hermes-plugin) (Memory Provider plugin over remote HTTP).
- **OpenCode** — [`the-librarian-opencode-plugin`](https://github.com/JimJafar/the-librarian-opencode-plugin) (Bun-runtime opencode plugin; chat.message pre-LLM privacy gate, runtime-install slash commands).
- **Pi** — [`the-librarian-pi-extension`](https://github.com/JimJafar/the-librarian-pi-extension) (Pi coding-agent package with native tools and `/lib-session-*` commands).

## What's still here

- **`shared/librarian-lifecycle/`** — the shared `@librarian/lifecycle`
  helper consumed by the Claude Code in-tree integration adapter.
  Houses the canonical TypeScript privacy detector that the Codex JS
  port, the Hermes Python port, and the OpenCode direct port all stay
  in lockstep with.

## Conventions across the family

- All session commands route through the `/lib:session` surface
  documented at [`docs/slash-commands.md`](../docs/slash-commands.md).
- The canonical instance is a **single shared Librarian** reachable
  over HTTP MCP. See the spec for topology details — local-only
  installs are not supported for session continuity.
- Sessions default to `common` visibility. Agents must detect
  sensitivity signals and confirm before starting a `common` session
  whose content looks private. The store/MCP layer trusts the
  visibility the caller supplies.
- Session history is **evidence**, not durable memory. Promote facts
  via `/lib:session end`'s candidates or `promote_session_fact` —
  never auto-promote.
