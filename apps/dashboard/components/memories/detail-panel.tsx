"use client";

import { useState, useTransition } from "react";
import { CATEGORIES, SCOPES, VISIBILITIES, type MemoryRow } from "./types";
import { archiveMemoryAction, updateMemoryAction } from "@/app/(memories)/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Props {
  memory: MemoryRow;
  onClose: () => void;
  onMutated: () => void;
}

export function MemoryDetailPanel({ memory, onClose, onMutated }: Props) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <aside className="flex flex-col gap-4 rounded-md border bg-card p-4">
      <header className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{memory.title || "(untitled)"}</h2>
          <div className="mt-1 flex flex-wrap gap-1">
            <Badge variant="outline">{memory.category}</Badge>
            <Badge variant="secondary">{memory.visibility}</Badge>
            <Badge variant="secondary">{memory.scope}</Badge>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close detail panel">
          ×
        </Button>
      </header>
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
            <span>Category</span>
            <select
              name="category"
              defaultValue={memory.category}
              className="h-10 rounded-md border border-input bg-background px-2"
            >
              {CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span>Visibility</span>
            <select
              name="visibility"
              defaultValue={memory.visibility}
              className="h-10 rounded-md border border-input bg-background px-2"
            >
              {VISIBILITIES.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span>Scope</span>
            <select
              name="scope"
              defaultValue={memory.scope}
              className="h-10 rounded-md border border-input bg-background px-2"
            >
              {SCOPES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
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
            <Button type="submit" disabled={pending}>
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
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button
              variant="destructive"
              size="sm"
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
    </aside>
  );
}
