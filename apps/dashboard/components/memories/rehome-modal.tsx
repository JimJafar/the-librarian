// D1.1 — re-home modal for the dashboard's bulk-update flow.
//
// One dropdown (target agent), populated by the `memories.distinctValues`
// tRPC procedure. Submitting calls `bulkUpdateMemoriesAction` which round-trips
// through tRPC's `memories.bulkUpdate`. The modal closes on success and clears
// its selection back to the parent view via `onSuccess`. (Memories are
// project-less now, so re-home is agent-only.)
//
// U3 — the hand-rolled Radix wrapper got replaced by the editorial
// `ui-v2/dialog.tsx` set, so the chrome stays consistent with the rest
// of the redesign.

"use client";

import { useState, useTransition } from "react";
import { bulkUpdateMemoriesAction } from "@/app/(memories)/actions";
import { Button } from "@/components/ui-v2/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui-v2/dialog";
import { Select } from "@/components/ui-v2/select";
import { trpc } from "@/lib/trpc-client";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIds: string[];
  onSuccess: (count: number) => void;
}

export function RehomeModal({ open, onOpenChange, selectedIds, onSuccess }: Props) {
  const [agentId, setAgentId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const agentQuery = trpc.memories.distinctValues.useQuery(
    { field: "agent_id" },
    { enabled: open },
  );

  const submit = () => {
    setError(null);
    if (agentId === "") {
      setError("Pick a target agent.");
      return;
    }
    startTransition(async () => {
      const result = await bulkUpdateMemoriesAction(selectedIds, { agent_id: agentId });
      if (result.ok) {
        onSuccess(result.updated);
        onOpenChange(false);
        setAgentId("");
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Re-home memories</DialogTitle>
          <DialogDescription>
            {selectedIds.length} memor{selectedIds.length === 1 ? "y" : "ies"} selected. Pick a
            target agent to re-home them to.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-foreground/60">Target agent</span>
            <Select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              aria-label="Target agent"
            >
              <option value="">(keep current)</option>
              {(agentQuery.data ?? []).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </label>
        </div>
        {error ? <p className="text-xs text-ink-accent">{error}</p> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={pending}>
            {pending ? "Re-homing…" : `Re-home ${selectedIds.length}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
