// Shared helpers for the harness-touching commands.

import type { LibrarianConfig } from "../config.js";
import { allHarnesses, isHarnessId, type HarnessModule } from "../harnesses/index.js";
import type { HarnessConfig } from "../harnesses/types.js";

/** Adapt the persisted config into the shape harness modules consume. */
export function toHarnessConfig(cfg: LibrarianConfig): HarnessConfig {
  return { mcpUrl: cfg.mcpUrl, token: cfg.token, serverUrl: cfg.serverUrl };
}

/**
 * Resolve named harness ids to modules, collecting any unknown ids. An empty
 * `named` list returns every harness (the "all" default for uninstall/update).
 */
export function resolveNamed(named: string[]): {
  harnesses: HarnessModule[];
  unknown: string[];
} {
  if (named.length === 0) return { harnesses: [...allHarnesses], unknown: [] };
  const harnesses: HarnessModule[] = [];
  const unknown: string[] = [];
  for (const id of named) {
    if (isHarnessId(id)) {
      harnesses.push(allHarnesses.find((h) => h.id === id) as HarnessModule);
    } else {
      unknown.push(id);
    }
  }
  return { harnesses, unknown };
}

/** Pull a clean message string off an unknown thrown value. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
