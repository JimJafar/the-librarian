---
title: Codex
description: Connect OpenAI Codex to The Librarian — shared memory and handoffs, no plugin code.
---

[Codex](https://developers.openai.com/codex) is OpenAI's coding agent. It supports
The Librarian's standard protocol (MCP) directly, so connecting it is **one
configuration block — no plugin, no code**.

**When you'd use this:** you work in Codex and want shared memory and handoffs
alongside your other tools.

**Before you start:** you need a running Librarian server, its **MCP URL**, and an
**agent token** — see [Install](/start-here/install/).

## The easy way

```sh
npx @the-librarian/cli install      # choose Codex; paste your MCP URL + token
npx @the-librarian/cli update       # later: refresh the integration
```

This writes the configuration block for you and installs the automatic-capture
hooks. Capture needs one extra opt-in: see [Automatic capture](#automatic-capture)
below.

## The manual way

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.librarian]
url = "https://librarian.example.com/mcp"
bearer_token_env_var = "LIBRARIAN_AGENT_TOKEN"
```

The token is referenced by **name** here, never written as a value — Codex sends
it only in the request header. Set it in your shell profile and restart Codex:

```sh
export LIBRARIAN_AGENT_TOKEN="<your-token>"
```

The `/mcp` panel should now list `librarian` with seven tools.

## What you get

- **Seven memory and handoff tools** — recall, remember, flag, store/list/claim
  handoffs, and search references.
- **The primer** — Codex presents The Librarian's briefing as guidance alongside
  the tools, so the recall/remember loop and the handoff protocol ride into every
  session with no setup.
- **Plain-language control** — Codex has no slash commands, so you simply say what
  you want: "hand this off", "pick up where I left off", "save what we learned",
  "go private". The agent maps each to the right action.

## Automatic capture

Codex can capture your conversation automatically, the same way Claude Code does.
The installer wires the hooks, but Codex will not **fire** them until you turn the
feature on — add this to `~/.codex/config.toml` and restart Codex:

```toml
[features]
codex_hooks = true
```

Capture is on by default once enabled, skips [private mode](/guides/private-mode/),
and can be switched off per machine with `LIBRARIAN_AUTO_SAVE=false`.

:::note[Honest status]
The exact shape of Codex's hook payload is modelled on a proven reference
implementation but has not yet been confirmed against a live Codex. The adapter is
built to **fail quietly** — if the real shape differs it simply captures nothing
rather than erroring. Explicit memory (telling the agent to remember) works
regardless.
:::

## Check it worked

Open Codex's `/mcp` panel; a healthy Librarian lists exactly **seven** tools. If
it does not appear, confirm `LIBRARIAN_AGENT_TOKEN` is set in the shell that
launched Codex.

## Full technical reference

For the complete configuration reference and capture details, see the
[Codex integration README](https://github.com/JimJafar/the-librarian/tree/main/integrations/codex).
