"use client";

import { EventsStream } from "./events-stream";
import { HandoverForm } from "./handover-form";
import { LifecycleActions } from "./lifecycle-actions";
import { PromoteForm } from "./promote-form";
import { isStale, type SessionRow } from "./types";
import { Badge } from "@/components/ui/badge";

export function SessionDetailView({ session }: { session: SessionRow }) {
  const stale = isStale(session);
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={badgeVariantForStatus(session.status)}>{session.status}</Badge>
          {stale ? <Badge variant="destructive">stale</Badge> : null}
          <h1 className="text-2xl font-semibold tracking-tight">{session.title || "(untitled)"}</h1>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground md:grid-cols-3 lg:grid-cols-4">
          <Field label="id" value={session.id} mono />
          <Field label="project" value={session.project_key ?? "(none)"} />
          <Field label="visibility" value={session.visibility} />
          <Field
            label="harness"
            value={session.current_harness ?? session.created_in_harness ?? "(unattached)"}
          />
          <Field
            label="agent"
            value={session.current_agent_id ?? session.created_by_agent_id ?? "(no agent)"}
          />
          <Field label="source" value={session.source_ref ?? "(none)"} />
          <Field label="started" value={new Date(session.started_at).toLocaleString()} />
          <Field
            label="last activity"
            value={new Date(session.last_activity_at).toLocaleString()}
          />
        </dl>
      </header>

      <SummarySection
        startSummary={session.start_summary}
        rollingSummary={session.rolling_summary}
        endSummary={session.end_summary}
        nextSteps={session.next_steps}
      />

      <LifecycleActions session={session} />

      <section className="rounded-md border bg-card p-4">
        <h2 className="mb-3 text-lg font-semibold">Events</h2>
        <EventsStream sessionId={session.id} />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <HandoverForm sessionId={session.id} />
        <PromoteForm sessionId={session.id} />
      </section>
    </div>
  );
}

function SummarySection({
  startSummary,
  rollingSummary,
  endSummary,
  nextSteps,
}: {
  startSummary: string | null;
  rollingSummary: string | null;
  endSummary: string | null;
  nextSteps: readonly string[];
}) {
  return (
    <section className="grid gap-3 md:grid-cols-3">
      <SummaryCard label="Start summary" body={startSummary} />
      <SummaryCard label="Rolling summary" body={rollingSummary} />
      <SummaryCard label="End summary" body={endSummary} />
      <div className="md:col-span-3">
        <h3 className="mb-2 text-sm font-medium text-muted-foreground">Next steps</h3>
        {nextSteps.length === 0 ? (
          <p className="text-sm text-muted-foreground">No next steps recorded.</p>
        ) : (
          <ul className="list-inside list-disc text-sm">
            {nextSteps.map((step, idx) => (
              <li key={idx}>{step}</li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function SummaryCard({ label, body }: { label: string; body: string | null }) {
  return (
    <div className="rounded-md border bg-card p-3">
      <h3 className="mb-2 text-sm font-medium text-muted-foreground">{label}</h3>
      {body ? (
        <p className="whitespace-pre-wrap text-sm">{body}</p>
      ) : (
        <p className="text-sm text-muted-foreground">(none)</p>
      )}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono text-foreground" : "text-foreground"}>{value}</dd>
    </div>
  );
}

function badgeVariantForStatus(
  status: SessionRow["status"],
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "active") return "default";
  if (status === "paused") return "secondary";
  return "outline";
}
