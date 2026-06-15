"use client";

import { useState, useTransition } from "react";
import { createMemoryAction } from "@/app/(memories)/actions";
import { Button } from "@/components/ui-v2/button";
import { Input } from "@/components/ui-v2/input";
import { SectionLabel } from "@/components/ui-v2/section-label";

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
      className="flex flex-col gap-3 border border-ink-hairline bg-ink-surface p-4 text-sm"
    >
      <label className="flex flex-col gap-1.5">
        <SectionLabel as="span">Title</SectionLabel>
        <Input name="title" required />
      </label>
      <label className="flex flex-col gap-1.5">
        <SectionLabel as="span">Body</SectionLabel>
        <textarea
          name="body"
          required
          className="min-h-[120px] border border-ink-hairline bg-ink-mono-fill p-2 font-mono text-xs leading-relaxed text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink-accent"
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <SectionLabel as="span">Tags</SectionLabel>
        <Input name="tags" placeholder="comma-separated" />
      </label>
      <p className="text-xs leading-relaxed text-foreground/60">
        The curator sets <code className="font-mono text-foreground/80">is_global</code> and{" "}
        <code className="font-mono text-foreground/80">requires_approval</code>. Memories that need
        owner review land in the proposal queue automatically.
      </p>
      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      <div>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
