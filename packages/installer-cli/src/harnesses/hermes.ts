// Hermes harness — STUB.
//
// Real logic (next wave): copy `integrations/hermes/librarian` →
// `~/.hermes/plugins/librarian` and set `memory.provider`; uninstall
// removes the dir + key; detect = dir present + provider set, version
// from the adapter's `plugin.yaml`. Until then, detect reports
// not-installed and the mutating ops throw NotImplemented.

import { NotImplemented, type HarnessConfig, type HarnessModule } from "./types.js";

export const hermes: HarnessModule = {
  id: "hermes",
  displayName: "Hermes",
  async detect() {
    return { installed: false };
  },
  async install(_cfg: HarnessConfig) {
    throw new NotImplemented("hermes", "install");
  },
  async uninstall() {
    throw new NotImplemented("hermes", "uninstall");
  },
  async update(_cfg: HarnessConfig) {
    throw new NotImplemented("hermes", "update");
  },
};
