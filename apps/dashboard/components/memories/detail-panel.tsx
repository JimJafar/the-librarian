"use client";

import { useState, useTransition } from "react";
import type { MemoryRow } from "./types";
import { archiveMemoryAction, updateMemoryAction } from "@/app/(memories)/actions";
import { chatAction, confirmActionAction, setAddendumAction } from "@/app/curator/actions";
import { DiscussMemoryButton } from "@/components/curator/discuss-memory-button";
import { Button } from "@/components/ui-v2/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui-v2/dialog";
import { Input } from "@/components/ui-v2/input";
import { Pill } from "@/components/ui-v2/pill";

interface Props {
  memory: MemoryRow;
  onClose: () => void;
  onMutated: () => void;
}

// Rendered as a centered modal (portaled to <body>) rather than a side
// column, so it stays in view regardless of how far the list is scrolled.
// The parent mounts this only while a memory is selected, so `open` is
// always true here; closing (Escape, overlay, the built-in X) routes
// through onOpenChange → onClose, which clears the selection upstream.
export function MemoryDetailPanel({ memory, onClose, onMutated }: Props) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{memory.title || "(untitled)"}</DialogTitle>
          <div className="mt-1 flex flex-wrap gap-1">
            {memory.is_global ? <Pill variant="muted">global</Pill> : null}
            {memory.requires_approval ? <Pill variant="muted">requires approval</Pill> : null}
          </div>
        </DialogHeader>
        {editing ? (
          <form
            action={(form) =>
              startTransition(async () => {
                const result = await updateMemoryAction(memory.id, form);
                if (result.ok) {
                  setEditing(false);
                  setError(null);
                  onMutated();
                } else {
                  setError(result.error);
                }
              })
            }
            className="flex flex-col gap-3 text-sm"
          >
            <label className="flex flex-col gap-1">
              <span>Title</span>
              <Input name="title" defaultValue={memory.title} />
            </label>
            <label className="flex flex-col gap-1">
              <span>Body</span>
              <textarea
                name="body"
                defaultValue={memory.body}
                className="min-h-[120px] rounded-md border border-input bg-background p-2"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span>Tags</span>
              <Input
                name="tags"
                defaultValue={memory.tags.join(", ")}
                placeholder="comma-separated"
              />
            </label>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <div className="flex gap-2">
              <Button type="submit" variant="primary" disabled={pending}>
                {pending ? "Saving…" : "Save"}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-3 text-sm">
            <p className="whitespace-pre-wrap">{memory.body}</p>
            {memory.tags.length > 0 ? (
              <p className="text-xs text-muted-foreground">tags: {memory.tags.join(", ")}</p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              id: <code>{memory.id}</code>
            </p>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <DiscussMemoryButton
                memoryId={memory.id}
                {...(memory.title ? { memoryTitle: memory.title } : {})}
                onChat={chatAction}
                onConfirmAction={confirmActionAction}
                onSetAddendum={setAddendumAction}
              />
              <Button
                variant="primary"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    if (!confirm(`Archive "${memory.title || memory.id}"?`)) return;
                    const result = await archiveMemoryAction(memory.id);
                    if (result.ok) {
                      setError(null);
                      onClose();
                      onMutated();
                    } else {
                      setError(result.error);
                    }
                  })
                }
              >
                Archive
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
