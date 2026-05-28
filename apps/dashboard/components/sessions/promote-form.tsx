"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { promoteSessionFactAction } from "@/app/sessions/[id]/actions";
import { Button } from "@/components/ui-v2/button";
import { Input } from "@/components/ui-v2/input";

export function PromoteForm({ sessionId }: { sessionId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  return (
    <section className="rounded-md border bg-card p-4">
      <h2 className="mb-2 text-lg font-semibold">Promote to memory</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        Lift a durable fact out of this session into the memory store. The classifier decides{" "}
        <code>is_global</code> and <code>requires_approval</code> asynchronously.
      </p>
      <form
        action={(form) =>
          startTransition(async () => {
            const result = await promoteSessionFactAction(sessionId, form);
            if (result.ok) {
              setError(null);
              setSaved(true);
              router.refresh();
            } else {
              setError(result.error);
              setSaved(false);
            }
          })
        }
        className="flex flex-col gap-3 text-sm"
      >
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Title</span>
          <Input name="memory_title" required />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Body</span>
          <textarea
            name="memory_body"
            required
            className="min-h-[100px] rounded-md border border-input bg-background p-2"
          />
        </label>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {saved ? <p className="text-sm text-foreground">Memory promoted.</p> : null}
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Saving…" : "Promote"}
        </Button>
      </form>
    </section>
  );
}
