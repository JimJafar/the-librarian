"use client";

import { useRouter } from "next/navigation";
import { SimpleMemoryList } from "./simple-list";
import type { MemoryRow } from "./types";
import { approveProposalAction, rejectProposalAction } from "@/app/(memories)/actions";

export function ProposalsView({ memories }: { memories: MemoryRow[] }) {
  const router = useRouter();
  return (
    <SimpleMemoryList
      memories={memories}
      expandBody
      emptyMessage="No proposals pending."
      actions={[
        {
          label: "Approve",
          variant: "primary",
          onAction: async (id) => {
            await approveProposalAction(id);
            router.refresh();
          },
        },
        {
          // Reject discards the proposal — destructive treatment (red
          // ochre) signals the consequence and respects the One Pen
          // Rule (the rubric verdigris stays with the single positive
          // action per row).
          label: "Reject",
          variant: "destructive",
          onAction: async (id) => {
            await rejectProposalAction(id);
            router.refresh();
          },
        },
      ]}
    />
  );
}
