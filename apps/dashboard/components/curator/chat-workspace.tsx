"use client";

// The curator chat workspace (spec 044 D-7, simplified by rethink D4). The general
// fresh-chat entry on the curator page: a job picker (intake / grooming) over the
// split-screen chat panel (chat left, addendum draft right). Committing an
// addendum applies it immediately — the job's next run reads it; "Roll back"
// restores the prior committed version (git is the rollback, D4). There is no
// evaluation lifecycle.
//
// The addendum DRAFT is lifted up here so the job picker can reset it to the
// picked job's committed text when the job changes.

import type { CuratorJob } from "@librarian/core";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ChatPanel } from "./chat-panel";
import type {
  chatAction,
  confirmActionAction,
  rollbackAddendumAction,
  setAddendumAction,
} from "@/app/curator/actions";

export interface JobAddendumState {
  content: string;
  version: string | null;
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
  // Per-job committed addendum state, read server-side on the curator page.
  jobs: Record<CuratorJob, JobAddendumState>;
  actions: ChatWorkspaceActions;
}) {
  const router = useRouter();
  const [job, setJob] = useState<CuratorJob>("grooming");
  const current = jobs[job];
  const [draft, setDraft] = useState(current.content);
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);

  const pickJob = (next: CuratorJob) => {
    setJob(next);
    setDraft(jobs[next].content);
    setNotice(null);
  };

  const rollback = () =>
    startTransition(async () => {
      setNotice(null);
      const result = await actions.onRollback({ job });
      if (result.ok) {
        setDraft(result.addendum.content);
        setNotice(`Rolled back — the prior ${job} addendum is committed and live.`);
        router.refresh();
      } else {
        setNotice(`Error: ${result.error}`);
      }
    });

  return (
    <section className="flex flex-col gap-4" aria-label="Curator chat workspace">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">Discuss with the curator about:</span>
        <label className="text-sm">
          <span className="sr-only">Curator job</span>
          <select
            aria-label="Curator job"
            value={job}
            onChange={(e) => pickJob(e.target.value as CuratorJob)}
            className="rounded-md border bg-background px-2 py-1 text-sm"
          >
            <option value="grooming">Grooming (the existing corpus)</option>
            <option value="intake">Intake (the inbox)</option>
          </select>
        </label>
      </div>

      <ChatPanel
        key={job}
        job={job}
        onChat={actions.onChat}
        onConfirmAction={actions.onConfirmAction}
        onSetAddendum={actions.onSetAddendum}
        draft={draft}
        onDraftChange={setDraft}
      />

      {/* Addendum edits apply immediately (rethink D4); git history is the version
          trail, so the one lifecycle control left is the git-based roll-back. */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50"
          disabled={pending || current.version === null}
          title={
            current.version === null
              ? "Nothing committed yet — there is no version to roll back to."
              : undefined
          }
          onClick={rollback}
        >
          Roll back addendum
        </button>
        {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
      </div>
    </section>
  );
}
