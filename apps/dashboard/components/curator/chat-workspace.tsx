"use client";

import type { CuratorJob } from "@librarian/core";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { ChatPanel } from "./chat-panel";
import type {
  chatAction,
  confirmActionAction,
  rollbackAddendumAction,
  setAddendumAction,
} from "@/app/curator/actions";
import { Button } from "@/components/ui-v2/button";
import { SectionLabel } from "@/components/ui-v2/section-label";
import { Select } from "@/components/ui-v2/select";

// Curator chat workspace (spec 044 D-7) — rebuilt onto the editorial
// system (Phase 4). Wraps the chat panel with a session strip (job picker
// + "conversations aren't saved" warning) at the top, and lifts the
// per-job rollback into a ghost link beneath the addendum panel inside
// the chat surface. The addendum draft is lifted up so swapping jobs
// resets it to the picked job's committed text.

export interface JobAddendumState {
  content: string;
  version: string | null;
  basePrompt: string;
  promptVersion: string;
}

export interface ChatWorkspaceActions {
  onChat: typeof chatAction;
  onConfirmAction: typeof confirmActionAction;
  onSetAddendum: typeof setAddendumAction;
  onRollback: typeof rollbackAddendumAction;
}

export function GroomingChatWorkspace({
  jobs,
  actions,
}: {
  jobs: Record<CuratorJob, JobAddendumState>;
  actions: ChatWorkspaceActions;
}) {
  const router = useRouter();
  const [job, setJob] = useState<CuratorJob>("grooming");
  const current = jobs[job];
  const [draft, setDraft] = useState(current.content);
  const [confirmingRollback, setConfirmingRollback] = useState(false);
  const [pending, startTransition] = useTransition();
  const [rollbackToast, setRollbackToast] = useState<string | null>(null);
  const [rollbackError, setRollbackError] = useState<string | null>(null);

  useEffect(() => {
    if (!rollbackToast) return;
    const id = window.setTimeout(() => setRollbackToast(null), 5000);
    return () => window.clearTimeout(id);
  }, [rollbackToast]);

  const pickJob = (next: CuratorJob) => {
    setJob(next);
    setDraft(jobs[next].content);
    setConfirmingRollback(false);
    setRollbackToast(null);
    setRollbackError(null);
  };

  const rollback = () =>
    startTransition(async () => {
      setRollbackError(null);
      const result = await actions.onRollback({ job });
      if (result.ok) {
        setDraft(result.addendum.content);
        setConfirmingRollback(false);
        setRollbackToast(`Rolled back — the prior ${job} addendum is committed and live.`);
        router.refresh();
      } else {
        setRollbackError(result.error);
      }
    });

  const hasPriorVersion = current.version !== null;

  return (
    <section className="flex flex-col gap-4" aria-label="Curator chat workspace">
      <div className="flex flex-wrap items-center gap-3 border-y border-ink-hairline bg-ink-surface px-4 py-3">
        <div className="flex items-center gap-2">
          <SectionLabel as="label" htmlFor="curator-job">
            Discuss
          </SectionLabel>
          <Select
            id="curator-job"
            aria-label="Curator job"
            variant="compact"
            value={job}
            onChange={(e) => pickJob(e.target.value as CuratorJob)}
          >
            <option value="grooming">Grooming (the existing corpus)</option>
            <option value="intake">Intake (the inbox)</option>
          </Select>
        </div>
        <p className="text-xs text-foreground/55">
          Conversations aren't saved — refresh starts a new thread.
        </p>
      </div>

      <ChatPanel
        key={job}
        job={job}
        onChat={actions.onChat}
        onConfirmAction={actions.onConfirmAction}
        onSetAddendum={actions.onSetAddendum}
        draft={draft}
        onDraftChange={setDraft}
        basePrompt={current.basePrompt}
        promptVersion={current.promptVersion}
      />

      <div className="flex flex-wrap items-center justify-end gap-3" aria-label="Addendum history">
        {rollbackError ? (
          <p
            role="alert"
            className="mr-auto border border-destructive/40 bg-destructive/[0.06] px-3 py-1.5 text-sm text-destructive"
          >
            {rollbackError}
          </p>
        ) : null}
        {rollbackToast ? (
          <p
            role="status"
            className="mr-auto border border-ink-accent/40 bg-ink-accent/[0.06] px-3 py-1.5 text-sm text-foreground"
          >
            {rollbackToast}
          </p>
        ) : null}
        {confirmingRollback ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-foreground/70">
              Restore the prior {job} addendum? The current draft will be replaced.
            </span>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmingRollback(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={rollback} disabled={pending}>
              {pending ? "Rolling back…" : "Roll back addendum"}
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="ghost"
            className="text-foreground/70 hover:text-foreground"
            disabled={!hasPriorVersion}
            title={
              hasPriorVersion
                ? undefined
                : "Nothing committed yet — there is no version to roll back to."
            }
            onClick={() => setConfirmingRollback(true)}
          >
            Roll back addendum →
          </Button>
        )}
      </div>
    </section>
  );
}
