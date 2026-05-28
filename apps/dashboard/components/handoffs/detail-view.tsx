"use client";

import { trpc } from "@/lib/trpc-client";

export function HandoffDetailView({ handoffId }: { handoffId: string }) {
  const result = trpc.handoffs.byId.useQuery({ handoff_id: handoffId });

  if (result.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (result.error) return <p className="text-sm text-destructive">{result.error.message}</p>;
  const handoff = result.data;
  if (!handoff) return <p className="text-sm text-muted-foreground">Handoff not found.</p>;

  return (
    <div className="grid gap-6 md:grid-cols-[2fr_1fr]">
      <article className="prose prose-sm max-w-none rounded-md border bg-card p-6">
        <h1 className="text-xl font-semibold">{handoff.title}</h1>
        <pre className="whitespace-pre-wrap font-sans text-sm">{handoff.document_md}</pre>
      </article>
      <aside className="flex flex-col gap-2 rounded-md border bg-card p-4 text-sm">
        <Row label="handoff_id" value={handoff.handoff_id} />
        <Row label="created_at" value={handoff.created_at} />
        <Row label="created_by" value={handoff.created_by_agent_id ?? "—"} />
        <Row label="created_in" value={handoff.created_in_harness ?? "—"} />
        <Row label="project_key" value={handoff.project_key ?? "—"} />
        <Row label="cwd" value={handoff.cwd ?? "—"} />
        <Row label="domain" value={handoff.domain} />
        <Row
          label="status"
          value={handoff.claimed_at ? `claimed at ${handoff.claimed_at}` : "unclaimed"}
        />
        {handoff.tags.length > 0 ? <Row label="tags" value={handoff.tags.join(", ")} /> : null}
      </aside>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs uppercase text-muted-foreground">{label}</span>
      <span className="font-mono text-xs break-all">{value}</span>
    </div>
  );
}
