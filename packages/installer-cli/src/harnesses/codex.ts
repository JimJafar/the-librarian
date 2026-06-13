// Codex harness — STUB.
//
// Real logic (next wave): install via
//   `codex mcp add librarian --url <U> --bearer-token-env-var LIBRARIAN_AGENT_TOKEN`
// uninstall via `codex mcp remove librarian`; detect = `~/.codex/config.toml`
// has `[mcp_servers.librarian]`, version = the config-shape version we
// stamp. Until then, detect reports not-installed and the mutating ops
// throw NotImplemented.

import { NotImplemented, type HarnessConfig, type HarnessModule } from "./types.js";

export const codex: HarnessModule = {
  id: "codex",
  displayName: "Codex",
  async detect() {
    return { installed: false };
  },
  async install(_cfg: HarnessConfig) {
    throw new NotImplemented("codex", "install");
  },
  async uninstall() {
    throw new NotImplemented("codex", "uninstall");
  },
  async update(_cfg: HarnessConfig) {
    throw new NotImplemented("codex", "update");
  },
};
