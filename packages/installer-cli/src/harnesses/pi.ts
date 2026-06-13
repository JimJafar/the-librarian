// Pi harness — STUB.
//
// Real logic (next wave): install via
//   `pi install npm:the-librarian-pi-extension`
// uninstall via `pi uninstall the-librarian-pi-extension`; detect =
// `pi list` contains it, version from npm/pi. Until then, detect reports
// not-installed and the mutating ops throw NotImplemented.

import { NotImplemented, type HarnessConfig, type HarnessModule } from "./types.js";

export const pi: HarnessModule = {
  id: "pi",
  displayName: "Pi",
  async detect() {
    return { installed: false };
  },
  async install(_cfg: HarnessConfig) {
    throw new NotImplemented("pi", "install");
  },
  async uninstall() {
    throw new NotImplemented("pi", "uninstall");
  },
  async update(_cfg: HarnessConfig) {
    throw new NotImplemented("pi", "update");
  },
};
