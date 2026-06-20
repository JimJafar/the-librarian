// The /proposals review queue (spec 2026-06-20 proposal-review-ux, T4).
//
// Renders the enriched memories.proposalsForReview rows: most as a standalone
// proposal-aware ProposalCard, split siblings grouped under their shared source
// with a one-click "Archive original" once the replacements are accepted.
//
// Reading Room system: hairline edges, sharp corners, the rubric accent held to
// the single primary action per card + the focus ring. Fail-soft: the archive
// affordance swallows a server-action failure rather than throwing out of the
// UI (AGENTS.md).

"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { archiveMemoryAction } from "@/app/(memories)/actions";
import { groupProposalRows, type ProposalGroup } from "@/components/memories/group-proposals";
import { ProposalCard } from "@/components/memories/proposal-card";
import type { ProposalReviewRow } from "@/components/memories/types";
import { Button } from "@/components/ui-v2/button";
import { Pill } from "@/components/ui-v2/pill";
import { SectionLabel } from "@/components/ui-v2/section-label";

export function ProposalsView({ rows }: { rows: ProposalReviewRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-foreground/60">No proposals pending.</p>;
  }

  const groups = groupProposalRows(rows);

  return (
    <ul className="flex flex-col gap-3">
      {groups.map((group) =>
        group.kind === "single" ? (
          <li key={group.row.proposal.id}>
            <ProposalCard row={group.row} />
          </li>
        ) : (
          <li key={`split-${group.source.id}`}>
            <SplitGroupBlock group={group} />
          </li>
        ),
      )}
    </ul>
  );
}

// A split group: the shared source shown once, then its replacement cards, then
// an "Archive original" affordance. D4/D5: approving a split replacement does
// NOT archive the source (an operator may keep some replacements and reject
// others), so archiving the source is an explicit, separate one-click action.
function SplitGroupBlock({ group }: { group: Extract<ProposalGroup, { kind: "split" }> }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const { source, replacements } = group;

  const archiveOriginal = () =>
    startTransition(async () => {
      try {
        await archiveMemoryAction(source.id);
        router.refresh();
      } catch {
        // Fail-soft: a Librarian/network failure must never throw out of the UI.
      }
    });

  return (
    <article
      aria-label={`Split of: ${source.title || "(untitled)"}`}
      className="flex flex-col gap-3 border border-ink-hairline bg-ink-surface p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Pill variant="accent" aria-label="Action: Split">
          Split
        </Pill>
        <Pill className="uppercase tracking-[0.08em]">grooming</Pill>
        <span className="font-mono text-[11px] text-foreground/55">
          {replacements.length} replacements
        </span>
      </div>

      {/* The shared source, shown once above its replacements. */}
      <section className="flex flex-col gap-1.5 border border-ink-hairline bg-foreground/[0.02] p-3">
        <SectionLabel>Original memory</SectionLabel>
        <h4 className="text-sm font-medium text-foreground">
          {source.title || <span className="italic text-foreground/55">(untitled)</span>}
        </h4>
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/70">
          {source.body}
        </p>
      </section>

      <div className="flex flex-col gap-2">
        <SectionLabel>Replacements</SectionLabel>
        <ul className="flex flex-col gap-2">
          {replacements.map((row) => (
            <li key={row.proposal.id}>
              <ProposalCard row={row} grouped />
            </li>
          ))}
        </ul>
      </div>

      {/* Archive the shared source once its replacements are accepted. A plain
          archive call — sharp-cornered, hairline, no second accent. */}
      <div className="flex items-center justify-between gap-2 border-t border-ink-hairline pt-3">
        <span className="text-sm text-foreground/60">
          Once the replacements are active, retire the original.
        </span>
        <Button variant="outline" disabled={pending} onClick={archiveOriginal}>
          Archive original
        </Button>
      </div>
    </article>
  );
}
