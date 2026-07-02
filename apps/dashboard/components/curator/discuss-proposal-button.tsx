"use client";

// "Discuss this proposal" — the proposal-scoped entry point to the curator
// chat (proposal-review rework F5 / D4). Same dialog + ChatPanel as
// DiscussMemoryButton, grounded in the PROPOSAL's memory id: the server
// extends the grounding with the judge's persisted plan + the resolved
// guessed target (gatherChatGrounding), so the conversation can weigh or
// redirect the intended filing. Works for legacy plan-less and
// grooming-sourced proposals too — grounding minus the plan.
//
// The confirm hook binds the proposal id (D9): a chat-proposed action the
// admin confirms ALSO consumes this proposal (archived, resolution
// "resolved_via_chat") so the queue holds no stale entry. Chat still
// proposes, never executes.

import type { ProposedAction } from "@librarian/core";
import { useState } from "react";
import { chatAction, confirmActionAction, setAddendumAction } from "@/app/curator/actions";
import { ChatPanel } from "@/components/curator/chat-panel";
import { Button } from "@/components/ui-v2/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui-v2/dialog";

export function DiscussProposalButton({
  proposalId,
  proposalTitle,
}: {
  proposalId: string;
  proposalTitle?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Discuss this proposal
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {/* A chat wants a stable, roomy canvas: near-viewport width (capped at
            7xl) and a fixed near-viewport height, with the header on an auto
            row and the panel on the 1fr row so the chat absorbs the extra
            space instead of leaving a squat dialog on big screens. A long
            conversation scrolls the content (1fr tracks grow to content). */}
        <DialogContent className="h-[min(64rem,calc(100dvh-3rem))] w-[calc(100vw-3rem)] max-w-7xl grid-rows-[auto_1fr] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Discuss this proposal with the curator</DialogTitle>
          </DialogHeader>
          <ChatPanel
            memoryId={proposalId}
            {...(proposalTitle ? { memoryTitle: proposalTitle } : {})}
            onChat={chatAction}
            onConfirmAction={(action: ProposedAction) => confirmActionAction(action, proposalId)}
            onSetAddendum={setAddendumAction}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
