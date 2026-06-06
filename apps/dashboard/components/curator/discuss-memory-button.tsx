"use client";

// "Discuss this memory" — the per-memory entry point to the curator chat (spec
// 044 D-7). Opens the split-screen chat panel in a dialog, PRE-POPULATED with the
// memory id (its content is grounded server-side; the job is inferred from the
// memory's decision history when unset). The admin can ask about the memory or
// request a fix-now action (which is proposed, never auto-run).
//
// The actions are passed in (server actions wired by the page/parent) so this stays
// a thin client wrapper around ChatPanel.

import { useState } from "react";
import { ChatPanel } from "./chat-panel";
import type { chatAction, confirmActionAction, setAddendumAction } from "@/app/curator/actions";
import { Button } from "@/components/ui-v2/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui-v2/dialog";

export function DiscussMemoryButton({
  memoryId,
  memoryTitle,
  onChat,
  onConfirmAction,
  onSetAddendum,
  variant = "outline",
}: {
  memoryId: string;
  memoryTitle?: string;
  onChat: typeof chatAction;
  onConfirmAction: typeof confirmActionAction;
  onSetAddendum: typeof setAddendumAction;
  variant?: "outline" | "ghost" | "primary";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
        Discuss this memory
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Discuss with the curator</DialogTitle>
          </DialogHeader>
          <ChatPanel
            memoryId={memoryId}
            {...(memoryTitle ? { memoryTitle } : {})}
            onChat={onChat}
            onConfirmAction={onConfirmAction}
            onSetAddendum={onSetAddendum}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
