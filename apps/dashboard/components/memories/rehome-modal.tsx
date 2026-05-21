// D1.1 — re-home modal for the dashboard's bulk-update flow.
//
// Two dropdowns (target agent + target project), each populated by the
// `memories.distinctValues` tRPC procedure. Submitting calls
// `bulkUpdateMemoriesAction` which round-trips through tRPC's
// `memories.bulkUpdate`. The modal closes on success and clears its
// selection back to the parent view via `onSuccess`.
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
import { trpc } from "@/lib/trpc-client";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIds: string[];
  onSuccess: (count: number) => void;
}

export function RehomeModal({ open, onOpenChange, selectedIds, onSuccess }: Props) {
  const [agentId, setAgentId] = useState("");
  const [projectKey, setProjectKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const agentQuery = trpc.memories.distinctValues.useQuery(
    { field: "agent_id" },
    { enabled: open },
  );
  const projectQuery = trpc.memories.distinctValues.useQuery(
    { field: "project_key" },
    { enabled: open },
  );

  const submit = () => {
    setError(null);
    if (agentId === "" && projectKey === "") {
      setError("Pick a target agent or a target project.");
      return;
    }
    const patch: { agent_id?: string; project_key?: string } = {};
    if (agentId) patch.agent_id = agentId;
    if (projectKey) patch.project_key = projectKey;
    startTransition(async () => {
      const result = await bulkUpdateMemoriesAction(selectedIds, patch);
      if (result.ok) {
        onSuccess(result.updated);
        onOpenChange(false);
        setAgentId("");
        setProjectKey("");
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
            target agent and/or project. Leave a field blank to keep its current value.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-foreground/60">Target agent</span>
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              className="h-9 border-0 border-b border-ink-hairline bg-transparent px-1 text-foreground"
            >
              <option value="">(keep current)</option>
              {(agentQuery.data ?? []).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-foreground/60">Target project</span>
            <select
              value={projectKey}
              onChange={(e) => setProjectKey(e.target.value)}
              className="h-9 border-0 border-b border-ink-hairline bg-transparent px-1 text-foreground"
            >
              <option value="">(keep current)</option>
              {(projectQuery.data ?? []).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
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
