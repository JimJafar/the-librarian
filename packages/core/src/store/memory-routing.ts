// Memory write-routing — the storage-agnostic decision of whether a write
// lands `active` or `proposed`, plus the routing booleans. Extracted from
// memory-store.ts (plan 036 Phase 2) so every backend shares one
// implementation.
//
// Post-rethink T4 (D7: classifier deleted) the decision reads only the plain
// trusted-options booleans: `requires_approval` / `is_global` set by trusted
// internal callers (the curator apply layer, admin tRPC) — never inferred.
// Agent-supplied `input.requires_approval` is ignored upstream (spec
// §4.1/§4.4).

import { MemoryStatus } from "../schemas/common.js";

export interface MemoryWriteVerdict {
  status: MemoryStatus;
  isGlobal: boolean;
  requiresApproval: boolean;
  curatorNote: Record<string, unknown> | null;
}

/**
 * Decide a memory write's landing status + routing booleans from its
 * `options`. `normalizedStatus` is the status from `normalizeMemoryInput`
 * (the default landing when no protection signal applies).
 */
export function routeMemoryWrite(
  normalizedStatus: string,
  options: Record<string, unknown> = {},
): MemoryWriteVerdict {
  const requiresApproval = options.requires_approval === true;
  const isGlobal = options.is_global === true;

  // requires_approval lands the write at `proposed` (awaiting review) unless a
  // trusted caller explicitly overrides the landing status.
  const status =
    (options.status as MemoryStatus | undefined) ||
    (requiresApproval ? MemoryStatus.Proposed : (normalizedStatus as MemoryStatus));

  // curator_note is curator-only provenance — accepted ONLY via the trusted
  // options channel, never from free-form input.
  const curatorNote =
    options.curator_note && typeof options.curator_note === "object"
      ? (options.curator_note as Record<string, unknown>)
      : null;

  return { status, isGlobal, requiresApproval, curatorNote };
}
