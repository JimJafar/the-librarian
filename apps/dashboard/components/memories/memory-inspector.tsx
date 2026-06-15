"use client";

// Right-rail Inspector for /memories — the desktop replacement for the
// portaled MemoryDetailPanel modal. Keeps the list visible while the
// operator reads / edits / archives a memory, which the modal couldn't.
//
// Same content as MemoryDetailPanel — title, body, tags, id, edit form,
// Discuss-with-curator action, Archive. The chrome differs: rail uses
// the ui-v2 Inspector wrapper (hairline left border + foreground/2 %
// fill + Fraunces title); modal uses the Dialog. Mobile keeps the
// modal until /impeccable adapt swaps it for a bottom sheet.

import { useEffect, useState, useTransition } from "react";
import type { MemoryRow } from "./types";
import { archiveMemoryAction, updateMemoryAction } from "@/app/(memories)/actions";
import { chatAction, confirmActionAction, setAddendumAction } from "@/app/curator/actions";
import { DiscussMemoryButton } from "@/components/curator/discuss-memory-button";
import { Button } from "@/components/ui-v2/button";
import { Input } from "@/components/ui-v2/input";
import { Pill } from "@/components/ui-v2/pill";
import { SectionLabel } from "@/components/ui-v2/section-label";

interface Props {
  memory: MemoryRow | null;
  onClose: () => void;
  onMutated: () => void;
}

export function MemoryInspector({ memory, onClose, onMutated }: Props) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Reset local state when the selected memory changes — otherwise an
  // edit-in-progress on memory A bleeds into memory B when the
  // operator clicks a different row.
  useEffect(() => {
    setEditing(false);
    setError(null);
  }, [memory?.id]);

  if (!memory) {
    return (
      <aside
        aria-label="Memory inspector"
        className="hidden h-full w-full flex-col gap-3 border-l border-ink-hairline bg-foreground/[0.02] p-5 lg:flex"
      >
        <h2 className="font-display text-xl text-foreground">Inspector</h2>
        <p className="text-sm text-foreground/55">
          Pick a memory from the list to read it, edit it, discuss it with the curator, or archive
          it.
        </p>
      </aside>
    );
  }

  return (
    <aside
      aria-label={`Memory ${memory.title || memory.id}`}
      className="hidden h-full w-full flex-col border-l border-ink-hairline bg-foreground/[0.02] lg:flex"
    >
      {/* Header — title + flags + close. Sticks while the body scrolls. */}
      <header className="flex items-start justify-between gap-2 border-b border-ink-hairline p-5 pb-3">
        <div className="min-w-0">
          <h2 className="break-words font-display text-xl text-foreground">
            {memory.title || <span className="italic text-foreground/55">(untitled)</span>}
          </h2>
          {(memory.is_global || memory.requires_approval) && (
            <div className="mt-2 flex flex-wrap gap-1">
              {memory.is_global ? <Pill variant="muted">global</Pill> : null}
              {memory.requires_approval ? <Pill variant="muted">requires approval</Pill> : null}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close inspector"
          className="-mr-2 -mt-1 px-2 py-1 text-foreground/55 transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent"
        >
          ×
        </button>
      </header>

      {/* Body — scrollable. */}
      <div className="flex-1 overflow-y-auto p-5">
        {editing ? (
          <EditForm
            memory={memory}
            pending={pending}
            error={error}
            onCancel={() => setEditing(false)}
            onSubmit={(form) =>
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
          />
        ) : (
          <div className="flex flex-col gap-5 text-sm">
            <p className="whitespace-pre-wrap leading-relaxed text-foreground">{memory.body}</p>
            {memory.tags.length > 0 ? (
              <div className="flex flex-col gap-2">
                <SectionLabel>Tags</SectionLabel>
                <div className="flex flex-wrap gap-1">
                  {memory.tags.map((tag) => (
                    <Pill key={tag} variant="default">
                      {tag}
                    </Pill>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="flex flex-col gap-2">
              <SectionLabel>Id</SectionLabel>
              <code className="break-all font-mono text-xs text-foreground/70">{memory.id}</code>
            </div>
            {error ? (
              <p
                role="alert"
                className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
              >
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2 pt-2">
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
                variant="destructive"
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
      </div>
    </aside>
  );
}

function EditForm({
  memory,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  memory: MemoryRow;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (form: FormData) => void;
}) {
  return (
    <form action={onSubmit} className="flex flex-col gap-4 text-sm">
      <label className="flex flex-col gap-1.5">
        <SectionLabel as="span">Title</SectionLabel>
        <Input name="title" defaultValue={memory.title} />
      </label>
      <label className="flex flex-col gap-1.5">
        <SectionLabel as="span">Body</SectionLabel>
        <textarea
          name="body"
          defaultValue={memory.body}
          className="min-h-[140px] border border-ink-hairline bg-ink-mono-fill p-2 font-mono text-xs leading-relaxed text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink-accent"
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <SectionLabel as="span">Tags</SectionLabel>
        <Input name="tags" defaultValue={memory.tags.join(", ")} placeholder="comma-separated" />
      </label>
      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
