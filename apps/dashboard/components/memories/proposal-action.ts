// The D5 action-badge mapping + the Approve-states-the-consequence rule, as
// pure functions so the proposal card's decisions can be tested without a DOM.
//
// The cardinal D5 rule: an authoritative, target-implying badge (Update /
// Replace / Merge / Split) appears ONLY when the proposal carries ≥1 resolved
// target. Intake create/augment/supersede file the raw submission with no
// target recorded (intake/apply.ts), so approving them replaces nothing — they
// are badged honestly as "New — needs filing", and the curator's guessed
// action survives only as descriptive text (never as an authoritative badge).
//
// The vocabulary (Update / Replace / Merge / Split / New) is kept consistent
// with curator/humanise-action.ts; that helper maps a structured chat
// ProposedAction, this one maps a stored curator_note `proposed_action` string
// plus the resolved target count — different inputs, one shared lexicon.

export interface ProposalActionInput {
  /** `curator_note.proposed_action` — may be absent on older/agent proposals. */
  action: string | null;
  /** Number of superseded sources the server resolved (`targets.length`). */
  targetCount: number;
}

export interface ProposalBadge {
  /** What the badge reads: "Update" / "Replace" / "Merge" / "Split" / "New"
   *  / "New — needs filing". */
  label: string;
  /** True when the badge authoritatively implies a target (Update/Replace/…),
   *  which D5 permits only when `targetCount ≥ 1`. A target-less proposal is
   *  never authoritative. */
  authoritative: boolean;
  /** For a non-authoritative (target-less) proposal, the curator's guessed
   *  action, surfaced as muted descriptive text only. `null` otherwise. */
  guessedAction: string | null;
}

// The authoritative label for each action when a target is present.
const TARGETED_LABEL: Record<string, string> = {
  update: "Update",
  supersede: "Replace",
  merge: "Merge",
  split: "Split",
  create: "New",
};

export function proposalBadge({ action, targetCount }: ProposalActionInput): ProposalBadge {
  // A move proposal is itself the authoritative request artifact. Its target
  // is enriched separately from `supersedes`, and may fail soft between queue
  // reads; neither case turns it into a new-content proposal.
  if (action === "move") {
    return { label: "Move", authoritative: true, guessedAction: null };
  }

  // No resolved target → never assert a target-implying action. This is the
  // intake create/augment/supersede case (and any proposal whose targets all
  // failed to resolve): badge it honestly and keep the guess as description.
  if (targetCount < 1) {
    return {
      label: "New — needs filing",
      authoritative: false,
      guessedAction: action,
    };
  }

  const label = action ? TARGETED_LABEL[action] : undefined;
  // A target is present but the action is unknown — still a real, target-bearing
  // proposal, so treat it as an authoritative (generic) New rather than the
  // "needs filing" intake copy.
  return {
    label: label ?? "New",
    authoritative: true,
    guessedAction: null,
  };
}

// Actions whose approval archives the superseded source(s) atomically (D4):
// update/supersede archive their single target, merge archives all sources.
// `split` is excluded — approving one replacement must not archive the shared
// source (the operator may accept some replacements and reject others), so the
// button must not promise it.
const ARCHIVES_ON_APPROVE = new Set(["update", "supersede", "merge"]);

export function approveConsequenceLabel({ action, targetCount }: ProposalActionInput): string {
  if (action && ARCHIVES_ON_APPROVE.has(action) && targetCount >= 1) {
    const noun = targetCount === 1 ? "memory" : "memories";
    const verb = action === "merge" ? "merges" : "replaces";
    return `Approve — ${verb} ${targetCount} ${noun}`;
  }
  return "Approve";
}
