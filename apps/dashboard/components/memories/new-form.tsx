"use client";

import { useState, useTransition } from "react";
import { createMemoryAction } from "@/app/(memories)/actions";
import { Button } from "@/components/ui-v2/button";
import { Input } from "@/components/ui-v2/input";

interface Props {
  onSaved: () => void;
}

export function NewMemoryForm({ onSaved }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      action={(form) =>
        startTransition(async () => {
          const result = await createMemoryAction(form);
          if (result.ok) {
            setError(null);
            onSaved();
          } else {
            setError(result.error);
          }
        })
      }
      className="flex flex-col gap-3 rounded-md border bg-card p-4 text-sm"
    >
      <label className="flex flex-col gap-1">
        <span>Title</span>
        <Input name="title" required />
      </label>
      <label className="flex flex-col gap-1">
        <span>Body</span>
        <textarea
          name="body"
          required
          className="min-h-[120px] rounded-md border border-input bg-background p-2"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span>Tags</span>
        <Input name="tags" placeholder="comma-separated" />
      </label>
      <p className="text-xs text-muted-foreground">
        The curator sets <code>is_global</code> and <code>requires_approval</code>. Memories that
        need owner review land in the proposal queue automatically.
      </p>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
