// The Librarian — Pi coding-agent extension (rethink spec §7, D14).
//
// Ported from the standalone the-librarian-pi-extension repo. The 2026-06-12
// rethink retires the conv-state injection, the per-turn conv_state fetch, and
// the 3-tool limitation; what survives is exactly:
//
//   - the 7 agent verbs (recall / remember / flag_memory / store_handoff /
//     list_handoffs / claim_handoff / search_references) as native Pi tool
//     proxies over the Librarian's stateless /mcp endpoint — see `tools.ts`;
//   - the ≤2KB primer, fetched from `GET /primer.md` once per process and
//     appended to the system prompt via `before_agent_start` — see `primer.ts`;
//   - four user-facing slash commands (`/handoff`, `/takeover`, `/learn`,
//     `/toggle-private`) as thin prompt templates — see `commands.ts`.
//
// Private mode is purely in-conversation: an `[librarian:private=on|off]`
// marker the LLM owns. There is no server flag, no on-disk state, and no
// privacy hook here.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.js";
import { readConfig } from "./config.js";
import { createMcpClient } from "./mcp-client.js";
import { createPrimerSource, registerPrimerHook } from "./primer.js";
import { registerLibrarianTools } from "./tools.js";

const CONFIG_HINT =
  "The Librarian is not configured. Set LIBRARIAN_MCP_URL and LIBRARIAN_AGENT_TOKEN.";

const COMMAND_VERBS = ["handoff", "takeover", "learn", "toggle-private"] as const;

export default function librarian(pi: ExtensionAPI): void {
  const config = readConfig();

  if (!config) {
    // Dormant: no endpoint/token → no tools, no hook, no automatic calls.
    // Still register the commands so they explain the missing configuration
    // instead of being "unknown command".
    for (const verb of COMMAND_VERBS) {
      pi.registerCommand(verb, {
        description: `${verb} (Librarian not configured)`,
        handler: async (_args, ctx) => {
          ctx.ui.notify(CONFIG_HINT, "warning");
        },
      });
    }
    return;
  }

  // One shared MCP client for all 7 tool proxies.
  const mcp = createMcpClient({
    endpoint: config.endpoint,
    token: config.token,
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
  });

  // Expose the Librarian's 7 verbs to the model directly (no mcp.json needed).
  registerLibrarianTools(pi, mcp);

  // Primer → system prompt, once per turn, cached per process, fail-soft.
  registerPrimerHook(pi, createPrimerSource({ endpoint: config.endpoint }));

  // The four user-facing slash commands (optional sugar, D9).
  registerCommands(pi);
}
