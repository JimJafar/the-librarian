// Confirmation modal for permanently deleting archived memories.
//
// Permanent delete is irreversible from the app (it hard-deletes the vault
// document; the deletion is a git commit, so only an admin could recover it from
// history). This modal lists the selected memories and gates the destructive
// action behind one deliberate confirmation click — the friction level Jim chose.

"use client";

import { useState, useTransition } from "react";
import type { MemoryRow } from "./types";
import { purgeMemoriesAction } from "@/app/(memories)/actions";
import { Button } from "@/components/ui-v2/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui-v2/dialog";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  memories: MemoryRow[];
  onDeleted: (count: number) => void;
}

export function ArchiveDeleteModal({ open, onOpenChange, memories, onDeleted }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const count = memories.length;

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const result = await purgeMemoriesAction(memories.map((m) => m.id));
      if (result.ok) {
        onDeleted(result.purged);
        onOpenChange(false);
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Permanently delete {count} memor{count === 1 ? "y" : "ies"}?
          </DialogTitle>
          <DialogDescription>
            This permanently deletes{" "}
            {count === 1 ? "this archived memory" : `these ${count} archived memories`} and
            can&apos;t be undone from the app.
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-48 overflow-y-auto text-sm">
          {memories.map((m) => (
            <li
              key={m.id}
              className="truncate border-b border-ink-hairline/50 py-1 last:border-0"
              title={m.title || "(untitled)"}
            >
              {m.title || "(untitled)"}
            </li>
          ))}
        </ul>
        {error ? <p className="text-xs text-ink-accent">{error}</p> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="outline"
            className="border-destructive/50 text-destructive hover:bg-destructive/10"
            onClick={submit}
            disabled={pending || count === 0}
          >
            {pending ? "Deleting…" : `Delete ${count}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
