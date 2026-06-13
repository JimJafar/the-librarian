// The harness registry: id → module.
//
// The single source of truth for "which harnesses exist". Commands iterate
// this in declaration order (the order the dashboard and prompts show them).
// The next wave swaps the stub modules for real implementations without
// touching this file.

import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { hermes } from "./hermes.js";
import { opencode } from "./opencode.js";
import { pi } from "./pi.js";
import type { HarnessId, HarnessModule } from "./types.js";

/** Every harness module, keyed by id. */
export const registry: Record<HarnessId, HarnessModule> = {
  claude,
  codex,
  opencode,
  hermes,
  pi,
};

/** The harness ids in canonical display order. */
export const HARNESS_IDS: readonly HarnessId[] = ["claude", "codex", "opencode", "hermes", "pi"];

/** All harness modules in canonical display order. */
export const allHarnesses: readonly HarnessModule[] = HARNESS_IDS.map((id) => registry[id]);

/** True iff `id` names a known harness. */
export function isHarnessId(id: string): id is HarnessId {
  return Object.prototype.hasOwnProperty.call(registry, id);
}

export type { HarnessConfig, HarnessModule, DetectResult, HarnessId } from "./types.js";
export { NotImplemented } from "./types.js";
