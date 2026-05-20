"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { SessionRow } from "./types";
import {
  archiveSessionAction,
  checkpointSessionAction,
  deleteSessionAction,
  endSessionAction,
  pauseSessionAction,
  restoreSessionAction,
} from "@/app/sessions/[id]/actions";
import { Button } from "@/components/ui/button";

type Mode = null | "checkpoint" | "pause" | "end";

export function LifecycleActions({ session }: { session: SessionRow }) {
  const [mode, setMode] = useState<Mode>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const isActive = session.status === "active";
  const isPaused = session.status === "paused";
  const isArchivedOrDeleted = session.status === "archived" || session.status === "deleted";

  const handle =
    (action: (id: string, form: FormData) => Promise<{ ok: boolean; error?: string }>) =>
    (form: FormData) =>
      startTransition(async () => {
        const result = await action(session.id, form);
        if (result.ok) {
          setMode(null);
          setError(null);
          router.refresh();
        } else {
          setError(result.error ?? "Unknown error");
        }
      });

  const archive = () =>
    startTransition(async () => {
      const reason = window.prompt("Archive reason (optional):") ?? undefined;
      const result = await archiveSessionAction(session.id, reason);
      if (result.ok) router.refresh();
      else setError(result.error);
    });

  const restore = () =>
    startTransition(async () => {
      const result = await restoreSessionAction(session.id);
      if (result.ok) router.refresh();
      else setError(result.error);
    });

  const remove = () =>
    startTransition(async () => {
      if (!window.confirm(`Delete session "${session.title}"?`)) return;
      const reason = window.prompt("Delete reason (optional):") ?? undefined;
      const result = await deleteSessionAction(session.id, reason);
      if (result.ok) router.refresh();
      else setError(result.error);
    });

  return (
    <section className="flex flex-col gap-3 rounded-md border bg-card p-4">
      <h2 className="text-lg font-semibold">Lifecycle</h2>
      <div className="flex flex-wrap gap-2">
        {isActive ? (
          <>
            <Button variant="outline" onClick={() => setMode("checkpoint")} disabled={pending}>
              Checkpoint
            </Button>
            <Button variant="outline" onClick={() => setMode("pause")} disabled={pending}>
              Pause
            </Button>
            <Button variant="outline" onClick={() => setMode("end")} disabled={pending}>
              End
            </Button>
          </>
        ) : null}
        {isPaused ? (
          <Button variant="outline" onClick={() => setMode("end")} disabled={pending}>
            End
          </Button>
        ) : null}
        {!isArchivedOrDeleted ? (
          <Button variant="outline" onClick={archive} disabled={pending}>
            Archive
          </Button>
        ) : null}
        {isArchivedOrDeleted ? (
          <Button variant="outline" onClick={restore} disabled={pending}>
            Restore
          </Button>
        ) : null}
        <Button variant="destructive" onClick={remove} disabled={pending}>
          Delete
        </Button>
      </div>
      {mode ? (
        <LifecycleForm
          label={mode}
          onSubmit={
            mode === "checkpoint"
              ? handle(checkpointSessionAction)
              : mode === "pause"
                ? handle(pauseSessionAction)
                : handle(endSessionAction)
          }
          onCancel={() => setMode(null)}
          pending={pending}
        />
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </section>
  );
}

function LifecycleForm({
  label,
  onSubmit,
  onCancel,
  pending,
}: {
  label: string;
  onSubmit: (form: FormData) => void;
  onCancel: () => void;
  pending: boolean;
}) {
  return (
    <form action={onSubmit} className="grid gap-3 text-sm md:grid-cols-2">
      <label className="md:col-span-2 flex flex-col gap-1">
        <span className="text-muted-foreground">Summary</span>
        <textarea
          name="summary"
          className="min-h-[80px] rounded-md border border-input bg-background p-2"
        />
      </label>
      <ListField name="decisions" label="Decisions (one per line)" />
      <ListField name="files_touched" label="Files touched (one per line)" />
      <ListField name="commands_run" label="Commands run (one per line)" />
      <ListField name="next_steps" label="Next steps (one per line)" />
      <ListField name="open_questions" label="Open questions (one per line)" />
      <label className="md:col-span-2 flex flex-col gap-1">
        <span className="text-muted-foreground">Reason (optional)</span>
        <input name="reason" className="h-9 rounded-md border border-input bg-background px-2" />
      </label>
      <div className="md:col-span-2 flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Working…" : `Submit ${label}`}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ListField({ name, label }: { name: string; label: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-muted-foreground">{label}</span>
      <textarea
        name={name}
        className="min-h-[60px] rounded-md border border-input bg-background p-2"
      />
    </label>
  );
}
