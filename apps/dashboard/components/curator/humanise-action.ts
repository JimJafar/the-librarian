// Humanise a curator-proposed action into a one-line intent gloss + a
// destructive verdict (used to colour the Confirm button). Keeps the raw
// JSON available for power users (the panel shows it behind a <details>
// disclosure); this helper is the plain-English summary that lets a
// first-time operator decide what a Confirm will actually do.
//
// The action types come from `@librarian/core/grooming-chat`
// (ProposedActionSchema): merge / split / update / unmerge.

import type { ProposedAction } from "@librarian/core";

interface HumanisedAction {
  /** Short, sentence-case verb phrase that titles the proposal —
   *  e.g. "Merge memories", "Update memory". Pairs with the
   *  PROPOSED FIX section label. */
  label: string;
  /** Lowercase noun for the confirmed-outcome line ("Confirmed — the
   *  <verb> was applied."). Singular, no leading article — e.g.
   *  "update", "merge", "split", "unmerge". */
  verb: string;
  /** One-line plain-English description of what Confirm will do. May
   *  reference ids inline (rendered as <code> by the caller). */
  intent: string;
  /** True when the action removes or replaces source memories whose
   *  prior shape can't be reconstructed without git history. The
   *  Confirm button wears the destructive variant when true. */
  destructive: boolean;
}

export function humaniseAction(action: ProposedAction): HumanisedAction {
  switch (action.type) {
    case "merge": {
      const count = action.source_ids.length;
      const sources = action.source_ids.map((id) => `\`${id}\``).join(", ");
      const title = action.replacement.title?.trim() || "(untitled)";
      return {
        label: "Merge memories",
        verb: "merge",
        intent: `Merge ${count} memories (${sources}) into a new memory titled "${title}". The sources are dropped.`,
        destructive: true,
      };
    }
    case "split": {
      const count = action.replacements.length;
      const titles = action.replacements
        .map((r) => `"${r.title?.trim() || "(untitled)"}"`)
        .join(", ");
      return {
        label: "Split memory",
        verb: "split",
        intent: `Split \`${action.source_id}\` into ${count} new memories: ${titles}. The source is dropped.`,
        destructive: true,
      };
    }
    case "update": {
      const fields = Object.keys(action.patch);
      const fieldList =
        fields.length === 0
          ? "no fields"
          : fields.length === 1
            ? `the \`${fields[0]}\``
            : `${fields.slice(0, -1).join(", ")} and ${fields.at(-1)}`;
      return {
        label: "Update memory",
        verb: "update",
        intent: `Update \`${action.id}\` — ${fieldList} ${fields.length === 1 ? "changes" : "change"}.`,
        destructive: false,
      };
    }
    case "unmerge": {
      return {
        label: "Unmerge memory",
        verb: "unmerge",
        intent: `Unmerge \`${action.id}\` back into its constituent memories. The merged memory is dropped.`,
        destructive: true,
      };
    }
  }
}
