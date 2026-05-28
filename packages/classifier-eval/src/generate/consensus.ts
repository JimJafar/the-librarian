// Consensus filter — given a candidate and N grader verdicts, return
// the unanimous label or `null` if any grader disagreed. Pure
// function; testable in isolation.
//
// The spec language is strict: "Keep only candidates where all three
// models agree on both booleans. If a candidate has any disagreement,
// drop it." So a null verdict from any grader (parse failure /
// provider error) counts as disagreement and the candidate drops.

import type { ClassifierVerdict } from "@librarian/classifier";

export interface ConsensusResult {
  /** The unanimous verdict, or null if the candidate must drop. */
  verdict: ClassifierVerdict | null;
  /** Why the candidate dropped, when verdict is null. Empty otherwise. */
  reason: string;
}

/**
 * Returns the unanimous verdict across `votes`, or null with a reason
 * when any grader disagreed or failed.
 *
 * The minimum-graders requirement is enforced by `PipelineConfigSchema`
 * (exactly 3 graders); this function still tolerates any non-empty
 * count so tests can exercise edge cases.
 */
export function consensusVerdict(votes: ReadonlyArray<ClassifierVerdict | null>): ConsensusResult {
  if (votes.length === 0) return { verdict: null, reason: "no votes" };
  const first = votes[0] ?? null;
  if (first === null) return { verdict: null, reason: "grader_failed" };
  for (let i = 1; i < votes.length; i++) {
    const vote = votes[i] ?? null;
    if (vote === null) return { verdict: null, reason: "grader_failed" };
    if (vote.requires_approval !== first.requires_approval || vote.is_global !== first.is_global) {
      return { verdict: null, reason: "disagreement" };
    }
  }
  return { verdict: first, reason: "" };
}
