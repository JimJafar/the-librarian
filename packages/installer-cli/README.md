# `@the-librarian/cli` — the `librarian` installer

A small cross-harness CLI that installs, updates, and tracks
[The Librarian](https://github.com/JimJafar/the-librarian)'s integrations across
all your harnesses and machines. Think of it as the package manager for your
Librarian setup: one tool you keep, driving each harness's **native** install
path rather than hand-editing five config formats.

Harnesses it manages: **Claude Code, Codex, OpenCode, Hermes, Pi.**

## Install

Run it straight from npm with `npx` — no global install needed:

```sh
npx @the-librarian/cli install
```

Prefer a persistent command? Install it globally once and call `librarian`
directly:

```sh
npm i -g @the-librarian/cli
librarian install
```

That's it — any harness you'd install into already has Node, so there's no
bootstrap script. `librarian install` with no args opens the interactive
multi-select and prompts once for your MCP URL + token; pass harness ids to
target specific ones. Re-run it any time to add a harness.

## Commands

```
librarian install   [harness…]   Install into one or more harnesses
                                  (no args → interactive multi-select; prompts
                                  for MCP URL + token once)
librarian uninstall [harness…]   Remove The Librarian from each harness
librarian update    [harness…]   Update the integration to the current version
librarian status                 Live table: harness · installed · version
librarian doctor                 Token set? server reachable? which harness CLIs?
librarian config                 Show or set MCP URL, token, server URL
librarian self-update            Update the CLI itself (coming in a later release)
librarian report                 Push this machine's state to the server
                                  (coming in a later release)
```

Useful flags: `--mcp-url <url>`, `--token <token>` (never printed),
`--shell <bash|zsh|fish>` to override shell detection, `-h/--help`,
`-v/--version`. Harness ids: `claude`, `codex`, `opencode`, `hermes`, `pi`. A
harness whose CLI isn't installed is reported `not-detected` and skipped — not
an error.

## What it writes to your environment

The CLI keeps everything under `~/.librarian/`:

- **`~/.librarian/env`** — a POSIX env file (`chmod 600`, owner-only) holding
  your two secrets:

  ```sh
  export LIBRARIAN_MCP_URL="…"
  export LIBRARIAN_AGENT_TOKEN="…"
  ```

- **`~/.librarian/machine-id`** — a UUID generated on first run, so the same
  setup on different machines stays distinct in the dashboard.

It adds **one** idempotent managed block to your shell rc (`~/.bashrc` /
`~/.zshrc`) that sources the env file:

```sh
# >>> librarian >>>
[ -f "$HOME/.librarian/env" ] && . "$HOME/.librarian/env"
# <<< librarian <<<
```

Fish can't source a POSIX file, so it instead gets a native
`~/.config/fish/conf.d/librarian.fish` with `set -gx`. Re-running any command
replaces the block — it never duplicates. `librarian config` rewrites
`~/.librarian/env`.

## Security

Your agent token is a credential. The CLI treats it like one:

- It's written **only** to `~/.librarian/env`, which is `chmod 600`
  (owner read/write only) — never to a committed or world-readable file.
- It is **never printed** (not in `status`, `doctor`, `config`, or logs) and
  never put in a URL — bearer tokens travel in headers, to the configured
  server, over the configured URL, and nowhere else.

If you ever need to rotate it, re-run `librarian config --token <new>` (or edit
`~/.librarian/env` directly).

> **Avoid `--token <value>` on a shared or audited machine.** A value passed on
> the command line is visible to anyone who can run `ps` while the command runs,
> and it lands in your shell history. Prefer entering the token at the
> interactive prompt — `librarian install` reads it with the echo **muted**, so
> it never appears on screen, in `ps`, or in history — or edit the `chmod 600`
> `~/.librarian/env` file directly.
