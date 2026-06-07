"use client";

// The curator chat workspace (spec 044 D-7). The general fresh-chat entry on the
// curator page: a job picker (intake / grooming) over the split-screen chat panel
// (chat left, addendum draft right), with the addendum-evaluation lifecycle
// controls (Accept / Roll-back / Dry-run / Re-evaluate) below.
//
// The addendum DRAFT is lifted up here so it's SHARED between the chat panel's
// editor and the lifecycle's Dry-run (which previews the current candidate). The
// picked job selects which addendum state + enablement the lifecycle shows; the
// draft resets to that job's committed text when the job changes.

import type { CuratorJob } from "@librarian/core";
import { useState } from "react";
import { AddendumLifecycle } from "./addendum-lifecycle";
import { ChatPanel } from "./chat-panel";
import type {
  acceptAddendumAction,
  chatAction,
  confirmActionAction,
  dryRunGroomingAction,
  reEvaluateAddendumAction,
  rollbackAddendumAction,
  setAddendumAction,
} from "@/app/curator/actions";

export interface JobAddendumState {
  content: string;
  version: string | null;
  status: "accepted" | "under_evaluation";
  evalVersion: string | null;
  enabled: boolean;
}

export interface ChatWorkspaceActions {
  onChat: typeof chatAction;
  onConfirmAction: typeof confirmActionAction;
  onSetAddendum: typeof setAddendumAction;
  onAccept: typeof acceptAddendumAction;
  onRollback: typeof rollbackAddendumAction;
  onReEvaluate: typeof reEvaluateAddendumAction;
  onDryRun: typeof dryRunGroomingAction;
}

export function GroomingChatWorkspace({
  jobs,
  actions,
}: {
  // Per-job addendum + enablement state, read server-side on the curator page.
  jobs: Record<CuratorJob, JobAddendumState>;
  actions: ChatWorkspaceActions;
}) {
  const [job, setJob] = useState<CuratorJob>("grooming");
  const current = jobs[job];
  const [draft, setDraft] = useState(current.content);

  const pickJob = (next: CuratorJob) => {
    setJob(next);
    setDraft(jobs[next].content);
  };

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

      <AddendumLifecycle
        job={job}
        status={current.status}
        evalVersion={current.evalVersion}
        enabled={current.enabled}
        candidate={draft}
        onAccept={actions.onAccept}
        onRollback={actions.onRollback}
        onReEvaluate={actions.onReEvaluate}
        onDryRun={actions.onDryRun}
      />
    </section>
  );
}
