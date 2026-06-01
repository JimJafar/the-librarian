// Memory write-routing — the storage-agnostic decision of whether a write
// lands `active` or `proposed`, plus the classifier-verdict booleans.
// Extracted from memory-store.ts (plan 036 Phase 2) so the SQLite and
// markdown backends share one implementation and can't drift.
//
// Section 4d.3 — the protected-routing decision reads explicit signals
// only: `pendingClassification` (classifier-cutover path), `outsideSession`
// (no conv_state context), and an explicit `options.requires_approval` from
// trusted internal callers (e.g. the curator apply layer). Agent-supplied
// `input.requires_approval` is ignored upstream (spec §4.1/§4.4).

import { MemoryStatus } from "../schemas/common.js";

export interface MemoryWriteVerdict {
  status: MemoryStatus;
  isGlobal: boolean;
  requiresApproval: boolean;
  curatorNote: Record<string, unknown> | null;
}

/**
 * Decide a memory write's landing status + verdict booleans from its
 * `options`. `normalizedStatus` is the status from `normalizeMemoryInput`
 * (the default landing when no protection signal applies).
 */
export function routeMemoryWrite(
  normalizedStatus: string,
  options: Record<string, unknown> = {},
): MemoryWriteVerdict {
  const outsideSession = options.outsideSession === true;
  const pendingClassification = options.pendingClassification === true;
  const explicitRequiresApproval =
    typeof options.requires_approval === "boolean" ? options.requires_approval : null;
  const explicitIsGlobal = typeof options.is_global === "boolean" ? options.is_global : null;

  const requiresApproval = pendingClassification
    ? true
    : outsideSession
      ? true
      : (explicitRequiresApproval ?? false);
  const isGlobal = pendingClassification ? false : (explicitIsGlobal ?? false);

  // forceActive overrides the landing status only — a write can require
  // approval yet still be activated by a trusted caller.
  const protectedWrite = (requiresApproval || outsideSession) && options.forceActive !== true;
  const status =
    (options.status as MemoryStatus | undefined) ||
    (pendingClassification || protectedWrite
      ? MemoryStatus.Proposed
      : (normalizedStatus as MemoryStatus));

  // curator_note is curator-only provenance — accepted ONLY via the trusted
  // options channel, never from free-form input.
  const curatorNote =
    options.curator_note && typeof options.curator_note === "object"
      ? (options.curator_note as Record<string, unknown>)
      : null;

  return { status, isGlobal, requiresApproval, curatorNote };
}
