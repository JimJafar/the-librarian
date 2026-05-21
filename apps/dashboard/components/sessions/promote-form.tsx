"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { promoteSessionFactAction } from "@/app/sessions/[id]/actions";
import { Button } from "@/components/ui-v2/button";
import { Input } from "@/components/ui-v2/input";

const CATEGORIES = [
  "lessons",
  "preferences",
  "projects",
  "environment",
  "tools",
  "people",
  "open_threads",
] as const;

export function PromoteForm({ sessionId }: { sessionId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  return (
    <section className="rounded-md border bg-card p-4">
      <h2 className="mb-2 text-lg font-semibold">Promote to memory</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        Lift a durable fact out of this session into the memory store.
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
        <div className="grid grid-cols-3 gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Category</span>
            <select
              name="memory_category"
              defaultValue="lessons"
              className="h-9 rounded-md border border-input bg-background px-2"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Visibility</span>
            <select
              name="memory_visibility"
              defaultValue="common"
              className="h-9 rounded-md border border-input bg-background px-2"
            >
              <option value="common">common</option>
              <option value="agent_private">agent_private</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Scope</span>
            <select
              name="memory_scope"
              defaultValue="global"
              className="h-9 rounded-md border border-input bg-background px-2"
            >
              <option value="global">global</option>
              <option value="project">project</option>
              <option value="environment">environment</option>
              <option value="tool">tool</option>
              <option value="session">session</option>
            </select>
          </label>
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {saved ? <p className="text-sm text-foreground">Memory promoted.</p> : null}
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Saving…" : "Promote"}
        </Button>
      </form>
    </section>
  );
}
