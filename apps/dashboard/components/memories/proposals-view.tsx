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
          label: "Reject",
          variant: "primary",
          onAction: async (id) => {
            await rejectProposalAction(id);
            router.refresh();
          },
        },
      ]}
    />
  );
}
