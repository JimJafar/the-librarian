# Spec: `librarian` — cross-harness installer CLI

**Status:** Approved to build (Phase 1), 2026-06-13. Decisions: Node CLI bootstrapped by `curl|bash`; server-reported cross-machine visibility (owner, 2026-06-13).

## 1. Objective

Make installing, updating, and tracking the Librarian's harness integrations trivial for someone who runs several harnesses across several machines. One bootstrap line installs a small CLI (`librarian`); that CLI is the package-manager-style tool you use forever after, and it reports each machine's state to your own server so the dashboard is the single place you see "which harnesses, which machines, which versions, what needs updating."

Success looks like: `curl -fsSL https://raw.githubusercontent.com/JimJafar/the-librarian/main/install.sh | bash`, answer two prompts (MCP URL, token) and pick harnesses, and you're done — on every machine — with `librarian status` (local) and the dashboard's **Installs** view (all machines) telling you exactly where things stand.

## 2. Shape (the brew model)

- **`install.sh`** (served raw from `main`): detect OS + Node; install the CLI; run `librarian install`. Idempotent; also documents an inspect-first path. Piping to a shell is opt-in, never the only way.
- **`librarian` CLI** (Node, published to npm): a *thin cross-harness orchestrator* — it drives each harness's **native** install path rather than hand-editing five config formats, manages the shared env vars, gives a live `status`, and (Phase 2) reports to the server.

The CLI is a NEW public package, distinct from the private server-admin `@librarian/cli` (rebuild/seed/migrate-data-dir). Bin name: **`librarian`**; package: **`@the-librarian/cli`** (scoped to the `@the-librarian` npm org, published with `"publishConfig": { "access": "public" }`; owner decision). Bootstrap one-liner: `npm i -g @the-librarian/cli`.

## 3. CLI command surface

```
librarian install   [harness…]   # interactive multi-select if none named; prompts for URL+token once
librarian uninstall [harness…]
librarian update    [harness…]   # to the current version; idempotent
librarian status                 # live table: harness | installed | version | latest | update? | url
librarian doctor                 # token set? server reachable? which harness CLIs are present?
librarian config                 # show/set MCP URL, token, server URL
librarian self-update            # update the CLI itself
librarian report                 # push this machine's state to the server (auto-run after install/update)
```

Harness ids: `claude`, `codex`, `opencode`, `hermes`, `pi`.

## 4. Per-harness contracts

Each harness is a module implementing `detect()`, `install(cfg)`, `uninstall()`, `update(cfg)`. Prefer the harness's own CLI; only edit a config file where there's no native command.

| Harness | install / uninstall | detect (installed?) + version |
|---|---|---|
| **claude** | `claude plugin marketplace add JimJafar/the-librarian` + `plugin install the-librarian@the-librarian` / `plugin remove` | marketplace listed + plugin present; version from the plugin manifest |
| **codex** | `codex mcp add librarian --url <U> --bearer-token-env-var LIBRARIAN_AGENT_TOKEN` / `codex mcp remove librarian` | `~/.codex/config.toml` has `[mcp_servers.librarian]`; version = config-shape version we stamp |
| **opencode** | edit `opencode.json`: add `mcp.librarian` remote block + `instructions:["<U>/primer.md"]` / remove the keys | `mcp.librarian` present; version stamped in a managed marker |
| **hermes** | copy `integrations/hermes/librarian` → `~/.hermes/plugins/librarian`, set `memory.provider` / remove dir + key | dir present + provider set; version from the adapter's `plugin.yaml` |
| **pi** | `pi install npm:the-librarian-pi-extension` / `pi uninstall the-librarian-pi-extension` | `pi list` contains it; version from npm/pi |

A harness whose CLI/binary isn't found is reported `not-detected` (skipped, not an error). The CLI fetches integration artifacts (Hermes dir, OpenCode block, command markdown) from a pinned release of the monorepo, not a floating clone.

## 5. Env + machine identity

- **Token + URL** never land in a committed rc. The CLI writes `~/.librarian/env` (`chmod 600`):
  ```sh
  export LIBRARIAN_MCP_URL="…"
  export LIBRARIAN_AGENT_TOKEN="…"
  ```
  and adds ONE idempotent managed block to the user's shell rc (bash/zsh source it; **fish** gets a native `~/.config/fish/conf.d/librarian.fish` with `set -gx`, since fish can't source a POSIX file):
  ```sh
  # >>> librarian >>>
  [ -f "$HOME/.librarian/env" ] && . "$HOME/.librarian/env"
  # <<< librarian <<<
  ```
  Re-runs replace the block, never duplicate. `librarian config` rewrites `~/.librarian/env`.
- **Machine id:** a UUID generated on first run, stored in `~/.librarian/machine-id`, plus the hostname for display. This is the dashboard's row key, so identical setups on different machines stay distinct.

## 6. Phase 2 — server report + dashboard (cross-machine, versions, update-status)

**Report (CLI → server, authed with the agent token):**
```
PUT /installs/<machine_id>            # upsert; Bearer LIBRARIAN_AGENT_TOKEN
{
  machine_id, hostname, reported_at, cli_version,
  harnesses: [
    { harness:"claude", installed:true, version:"1.0.0-rc.2", url:"…" },
    { harness:"codex",  installed:false },
    …
  ]
}
```
Auto-run after every `install`/`update`/`uninstall`; also `librarian report` on demand. A machine that goes away just stops reporting (its `reported_at` ages).

**Storage:** a `installs.json` sidecar in the data dir (same pattern as `intake-runs.json` etc.), keyed by `machine_id` — operational state, not vault memory.

**Dashboard — new "Installs" view:** one row per **machine** (hostname + last-seen, stale after N days greyed), each showing its harnesses with **version** and an **up-to-date / update-available** badge computed by comparing the reported version to the server's own current version (the server is the source of truth for "latest"). Multiple machines with the same harnesses render as separate rows — the explicit requirement. A summary line ("3 machines · 2 need updates") up top.

## 7. Distribution + publishing

- `@the-librarian/cli` publishes to npm under the `@the-librarian` org with `"publishConfig": { "access": "public" }`; `install.sh` does `npm i -g @the-librarian/cli` (Node assumed present or installed by the bootstrap).
- **Fold in the publish automation** the owner asked for: add an `npm publish` step to `.github/workflows/release.yml`, gated on an `NPM_TOKEN` repo secret, for the *public* packages only (`@the-librarian/cli` published with public access, `the-librarian-pi-extension`) — so releases publish automatically and nothing is hand-published. Private `@librarian/*` packages are excluded by their `private:true`.
- **OpenCode deprecation** points users at `npm i -g @the-librarian/cli && librarian install opencode`; gate running `npm deprecate` until after the CLI is published and `librarian install opencode` works end-to-end.
- **Archived plugin repos** (Claude Code / Codex / Hermes / Pi) carry a prominent deprecation banner at the top of each README, directing users back to the main `the-librarian` repo and to `npm i -g @the-librarian/cli`.

## 8. Structure / stack / testing

- New workspace package `packages/installer-cli` (`@the-librarian/cli`), Node 22 + TypeScript, same toolchain as the repo. Bin `librarian`.
- Per-harness modules under `src/harnesses/<id>.ts` behind a common interface; `src/env.ts`, `src/machine.ts`, `src/report.ts`, `src/status.ts`, `src/prompt.ts`.
- Vitest: each harness module tested against a fake home/config dir + a stub harness CLI on `PATH`; env-block idempotency; rc multi-shell; status table; report payload shape; bootstrap smoke (shellcheck the script).
- `install.sh` passes `shellcheck`.

## 9. Boundaries

- **Always:** idempotent operations; never write the token to a committed/world-readable file; live-probe for `status` (never trust a cached file as truth); one change per PR with version bump + CHANGELOG + tests (repo rule); the CLI never sends the token anywhere except the configured server, over the configured URL, in a header.
- **Ask first:** anything that edits a config the CLI didn't write (e.g. a pre-existing hand-rolled `mcp.librarian` with different settings — detect and confirm before overwriting); adding the `NPM_TOKEN` secret (owner does that in repo settings).
- **Never:** print the token; assume a harness is present without detecting it; leave a half-applied install on error (roll back the step).

## 10. Success criteria

1. `curl … install.sh | bash` on a clean machine → CLI installed, env block added, `librarian status` runs.
2. `librarian install` with no args → interactive picker; installs into each selected harness via its native path; `status` then shows them `installed` with a version.
3. `librarian status` live-probes truth even if a harness was hand-edited; shows `update-available` when the installed version is behind.
4. `uninstall` cleanly removes each harness's entry and (last one) offers to remove the env block.
5. Re-running any command is idempotent (no dup blocks, no dup config entries).
6. **Phase 2:** two machines reporting the same harnesses appear as two dashboard rows with per-harness versions and correct update badges.
7. Token never appears in any committed file, log, or the dashboard.
8. `pnpm test`/`typecheck`/`lint`/`shellcheck` green; PR with version bump + CHANGELOG.

## 11. Phase 1 task plan (build now)

- **T1** Scaffold `packages/installer-cli` (`@the-librarian/cli`, bin `librarian`), arg parser, `--help`, version.
- **T2** `env.ts` + `machine.ts`: `~/.librarian/{env,machine-id}` (600), managed rc block for bash/zsh/fish, idempotent; `config` command.
- **T3** Harness interface + **claude** + **codex** modules (detect/install/uninstall/update) with stub-CLI tests.
- **T4** **opencode** (JSON edit) + **hermes** (dir copy + config) + **pi** modules with tests.
- **T5** `install`/`uninstall`/`update` orchestration + interactive multi-select prompt; per-step rollback on error.
- **T6** `status` (live probe → table) + `doctor`.
- **T7** `install.sh` bootstrap (Node detect/install, `npm i -g`, run `librarian install`); shellcheck; README.
- **T8** Phase-1 gate: tests/lint/typecheck/shellcheck green, version bump + CHANGELOG, PR.

Phase 2 (server `PUT /installs` + `installs.json` + dashboard Installs view + `report`/`status --remote` + release.yml npm-publish automation) is a separate spec/PR once Phase 1 lands.
