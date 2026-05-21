// D1.1 — re-home modal for the dashboard's bulk-update flow.
//
// Two dropdowns (target agent + target project), each populated by the
// `memories.distinctValues` tRPC procedure. Submitting calls
// `bulkUpdateMemoriesAction` which round-trips through tRPC's
// `memories.bulkUpdate`. The modal closes on success and clears its
// selection back to the parent view via `onSuccess`.

"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState, useTransition } from "react";
import { bulkUpdateMemoriesAction } from "@/app/(memories)/actions";
import { Button } from "@/components/ui/button";
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
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-foreground/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(480px,90vw)] -translate-x-1/2 -translate-y-1/2 rounded-md border bg-card p-5 text-sm">
          <Dialog.Title className="text-lg font-semibold">Re-home memories</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-muted-foreground">
            {selectedIds.length} memor{selectedIds.length === 1 ? "y" : "ies"} selected. Pick a
            target agent and/or project. Leave a field blank to keep its current value.
          </Dialog.Description>
          <div className="mt-4 grid gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Target agent</span>
              <select
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                className="h-9 rounded-md border bg-background px-2"
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
              <span className="text-xs text-muted-foreground">Target project</span>
              <select
                value={projectKey}
                onChange={(e) => setProjectKey(e.target.value)}
                className="h-9 rounded-md border bg-background px-2"
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
          {error ? <p className="mt-3 text-xs text-destructive">{error}</p> : null}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={pending}>
              {pending ? "Re-homing…" : `Re-home ${selectedIds.length}`}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
