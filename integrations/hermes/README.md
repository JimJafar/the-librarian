# Hermes integration

Wires Hermes (Discord-fronted multi-agent runtime) into The Librarian's session layer.

## Install

1. **Point Hermes at the canonical Librarian HTTP MCP endpoint.** Use the snippet in [`config.example.yaml`](./config.example.yaml). The agent token must be a per-agent token (`LIBRARIAN_AGENT_TOKENS`) so the server can attribute sessions correctly.

2. **Merge `AGENTS.append.md` into Hermes's `AGENTS.md`.** This is *not* a standalone file — it's a snippet you concatenate onto your existing agent instructions:
   ```sh
   cat integrations/hermes/AGENTS.append.md >> path/to/your/hermes/AGENTS.md
   ```

3. **Wire `/lib:session` slash commands** natively where Hermes supports them (autocomplete, structured args). In agent/skill contexts that only see free-form user messages, the agent recognises `/lib:session ...` in text and routes to the same MCP tools. Both paths converge on the same MCP surface.

4. **Run the healthcheck.** See [`healthcheck.md`](./healthcheck.md).

## What this package does NOT change

- The session layer is additive. Hermes's native Discord thread continuation keeps working — `/lib:session` exists alongside it, not in place of it.
- Durable memory (`remember`, `propose_memory`, etc.) is unchanged; this package only adds session lifecycle on top.

## See also

- Canonical slash command contract: [`docs/slash-commands.md`](../../docs/slash-commands.md)
- Full session spec: [`specs/done/session-layer-and-harness-packages.md`](../../specs/done/session-layer-and-harness-packages.md)
- Use-the-librarian skill: [`skills/use-the-librarian/SKILL.md`](../../skills/use-the-librarian/SKILL.md)
