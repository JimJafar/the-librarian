// Curator apply-decision policy (spec §11). The PURE rules that map a validated,
// accepted operation + the admin `default_auto_apply` level + the confidence
// threshold to one of: auto_apply / propose / skip. Execution (the actual store
// mutations and proposal creation) is a separate layer; this is just the policy.
//
// The protected guard is un-relaxable: identity/relationship operations never
// auto-apply regardless of level or confidence — create/update/merge/split route
// to a human proposal, and a protected pure-archive (no replacement) is skipped
// and audited (§11). Within non-protected discretion, `safe_only` (v1 default)
// auto-applies only `safe`-risk ops; `high_confidence` auto-applies any
// non-protected op; both gate on the confidence threshold; `off` applies nothing.

import type { AutoApplyLevel } from "./curator-config.js";
import type { CuratorOperation } from "./curator-output.js";
import type { RiskLevel } from "./curator-validate.js";

export type ApplyDecision = "auto_apply" | "propose" | "skip";

export interface ApplyPolicy {
  level: AutoApplyLevel;
  confidenceThreshold: number;
}

/** The accept-branch classification from §10.5 validation. */
export interface AcceptedClassification {
  risk: RiskLevel;
  isProtected: boolean;
}

export function decideApply(
  operation: CuratorOperation,
  accepted: AcceptedClassification,
  policy: ApplyPolicy,
): ApplyDecision {
  // A noop changes nothing.
  if (operation.type === "noop") return "skip";

  // Protected categories never auto-apply (hard guard, above level + confidence):
  // create/update/merge/split become human proposals; a pure protected archive
  // has no replacement to propose, so it is skipped + audited.
  if (accepted.isProtected) {
    return operation.type === "archive" ? "skip" : "propose";
  }

  // Non-protected discretion, gated by level + confidence. The threshold check
  // sits before the level branches so it applies to safe_only AND high_confidence
  // uniformly.
  if (policy.level === "off") return "skip";
  if (operation.confidence < policy.confidenceThreshold) return "skip";
  if (policy.level === "high_confidence") return "auto_apply"; // any non-protected op
  if (policy.level === "safe_only" && accepted.risk === "safe") return "auto_apply";
  // Fail closed: safe_only below the safe bar, or any unrecognised future level,
  // is skipped — a new AutoApplyLevel can never silently auto-apply.
  return "skip";
}
