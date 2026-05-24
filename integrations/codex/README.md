# Codex integration

Wires Codex (cwd-oriented coding agent) into The Librarian's session layer.

## Install

1. **Add the MCP server to Codex.** Copy [`mcp.example.json`](./mcp.example.json) into Codex's MCP configuration. Set `LIBRARIAN_AGENT_TOKEN` in the environment.

2. **Drop [`AGENTS.md`](./AGENTS.md) into the project root** (or merge with an existing `AGENTS.md`). Codex reads it on session start and learns the `/lib:session` contract and Codex-specific guidance.

3. **Enable the automatic lifecycle hooks (recommended — Codex is first-class with hooks on).** With `[features] hooks = true`, Codex's synchronous `UserPromptSubmit` hook is a genuine pre-agent privacy gate. Install the hook script and merge the config:
   ```sh
   mkdir -p ~/.codex/hooks/librarian
   cp integrations/codex/hooks/librarian/dispatch.sh ~/.codex/hooks/librarian/
   chmod +x ~/.codex/hooks/librarian/dispatch.sh
   # merge integrations/codex/hooks/config.example.toml into ~/.codex/config.toml,
   # replacing the command path. (Codex restricts hooks/notify in project-local
   # config.toml — use the user-level file.)
   ```
   Requires `the-librarian` and `librarian-codex-hook` (from `@librarian/lifecycle`) on `PATH`. Set `LIBRARIAN_AGENT_ID` and optionally `LIBRARIAN_PROJECT_KEY`. The gate **never blocks your prompt** — it only suppresses the Librarian call when off-record — and is a silent no-op if the helper isn't installed.

4. **Optionally use [`wrapper.sh`](./wrapper.sh)** to bracket `codex` invocations with `the-librarian sessions start` (on launch) and `pause` (on exit). The wrapper also covers pause-on-exit, which the hooks can't (Codex has no `SessionEnd` event):
   ```sh
   chmod +x integrations/codex/wrapper.sh
   integrations/codex/wrapper.sh --project the-librarian -- codex
   ```

5. **Run the healthcheck.** See [`healthcheck.md`](./healthcheck.md).

## Automatic lifecycle & privacy

The hooks (step 3) are a thin shell around the `librarian-codex-hook` bin, which maps Codex hook events onto the shared lifecycle helper ([`integrations/shared/librarian-lifecycle`](../shared/librarian-lifecycle)):

| Codex event | Action |
|---|---|
| `UserPromptSubmit` | Privacy gate + start/resume (idempotent). |
| `PostCompact` | Checkpoint (high-value boundary). |
| `SessionStart` / `PreCompact` / `Stop` | No-op (state is created lazily on the first prompt). |

Codex has no `SessionEnd` or `TaskCompleted` event, so pause-on-exit is the wrapper's job. **When hooks are off** (`[features] hooks = false`), there is no synchronous pre-agent gate: privacy detection is best-effort instruction-following per `AGENTS.md`, and automatic start should stay disabled. Privacy fails closed: if the hook can't read/write its local state it makes no automatic Librarian call. See [`docs/specs/harness-commands-and-lifecycle-spec.md`](../../docs/specs/harness-commands-and-lifecycle-spec.md) §7.3.

## Source ref shape

Codex is cwd-oriented. The wrapper records `source_ref` as `cwd:{absolute_path}` by default. If Codex exposes a native run id (e.g. via env var `CODEX_RUN_ID`), the wrapper uses `codex:run:{run_id}:cwd:{abs_path}` so the handover can name the specific run.

## Handover format

`continue_session --format codex` produces a concise `AGENTS`-style handover suitable for pasting into Codex's system prompt or for consumption by another Codex run.

## See also

- Canonical slash command contract: [`docs/slash-commands.md`](../../docs/slash-commands.md)
- Full session spec: [`specs/done/session-layer-and-harness-packages.md`](../../specs/done/session-layer-and-harness-packages.md)
