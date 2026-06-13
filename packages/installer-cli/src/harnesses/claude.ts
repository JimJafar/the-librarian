// Claude Code harness — STUB.
//
// Real logic (next wave): install via
//   `claude plugin marketplace add JimJafar/the-librarian`
//   + `plugin install the-librarian@the-librarian`
// uninstall via `plugin remove`; detect = marketplace listed + plugin
// present, version from the plugin manifest. Until then, detect reports
// not-installed and the mutating ops throw NotImplemented.

import { NotImplemented, type HarnessConfig, type HarnessModule } from "./types.js";

export const claude: HarnessModule = {
  id: "claude",
  displayName: "Claude Code",
  async detect() {
    return { installed: false };
  },
  async install(_cfg: HarnessConfig) {
    throw new NotImplemented("claude", "install");
  },
  async uninstall() {
    throw new NotImplemented("claude", "uninstall");
  },
  async update(_cfg: HarnessConfig) {
    throw new NotImplemented("claude", "update");
  },
};
