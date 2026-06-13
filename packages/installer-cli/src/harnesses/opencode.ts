// OpenCode harness — STUB.
//
// Real logic (next wave): no native command — edit `opencode.json` to add
// an `mcp.librarian` remote block + `instructions:["<U>/primer.md"]`;
// uninstall removes those keys; detect = `mcp.librarian` present, version
// stamped in a managed marker. Until then, detect reports not-installed
// and the mutating ops throw NotImplemented.

import { NotImplemented, type HarnessConfig, type HarnessModule } from "./types.js";

export const opencode: HarnessModule = {
  id: "opencode",
  displayName: "OpenCode",
  async detect() {
    return { installed: false };
  },
  async install(_cfg: HarnessConfig) {
    throw new NotImplemented("opencode", "install");
  },
  async uninstall() {
    throw new NotImplemented("opencode", "uninstall");
  },
  async update(_cfg: HarnessConfig) {
    throw new NotImplemented("opencode", "update");
  },
};
