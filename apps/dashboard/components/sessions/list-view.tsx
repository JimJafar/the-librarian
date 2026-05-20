"use client";

import Link from "next/link";
import { useState } from "react";
import { isStale, type SessionRow } from "./types";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc-client";

const PAGE_LIMIT = 50;

export function SessionsListView() {
  const [query, setQuery] = useState("");
  const [projectKey, setProjectKey] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [includeDeleted, setIncludeDeleted] = useState(false);

  const hasQuery = query.trim().length > 0;

  // Branch between `.list` and `.search`: the store's search short-circuits
  // to an empty result when `query` is blank, so we use `.list` for the
  // default page load and switch to `.search` only when there's a query.
  const listInput = {
    limit: PAGE_LIMIT,
    include_archived: includeArchived,
    include_deleted: includeDeleted,
    ...(projectKey ? { project_key: projectKey } : {}),
  } as Parameters<typeof trpc.sessions.list.useQuery>[0];

  const searchInput = {
    limit: PAGE_LIMIT,
    include_archived: includeArchived,
    include_deleted: includeDeleted,
    query: query.trim(),
    ...(projectKey ? { project_key: projectKey } : {}),
  } as Parameters<typeof trpc.sessions.search.useQuery>[0];

  const listResult = trpc.sessions.list.useQuery(listInput, { enabled: !hasQuery });
  const searchResult = trpc.sessions.search.useQuery(searchInput, { enabled: hasQuery });
  const active = hasQuery ? searchResult : listResult;
  const sessions = (active.data?.sessions ?? []) as SessionRow[];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 rounded-md border bg-card p-3 text-sm md:grid-cols-[1fr_1fr_auto_auto]">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Search</span>
          <Input
            value={query}
            placeholder="title, summary, decisions, notes"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Project</span>
          <Input
            value={projectKey}
            placeholder="project key"
            onChange={(e) => setProjectKey(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
          <span>Include archived</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={includeDeleted}
            onChange={(e) => setIncludeDeleted(e.target.checked)}
          />
          <span>Include deleted</span>
        </label>
      </div>
      {active.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading sessions…</p>
      ) : active.isError ? (
        <p className="text-sm text-destructive">Failed to load sessions: {active.error.message}</p>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No sessions match these filters.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {sessions.map((session) => (
            <SessionRowItem key={session.id} session={session} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SessionRowItem({ session }: { session: SessionRow }) {
  const stale = isStale(session);
  const nextStep = session.next_steps[0] ?? null;
  return (
    <li>
      <Link
        href={`/sessions/${session.id}`}
        className="flex flex-col gap-1 rounded-md border bg-card p-3 transition-colors hover:bg-accent"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={badgeVariantForStatus(session.status)}>{session.status}</Badge>
          {stale ? <Badge variant="destructive">stale</Badge> : null}
          <h3 className="truncate font-medium">{session.title || "(untitled)"}</h3>
        </div>
        <dl className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <Field label="project" value={session.project_key} />
          <Field label="visibility" value={session.visibility} />
          <Field
            label="harness"
            value={session.current_harness ?? session.created_in_harness ?? "(unattached)"}
          />
          <Field
            label="agent"
            value={session.current_agent_id ?? session.created_by_agent_id ?? "(no agent)"}
          />
          <Field label="source" value={session.source_ref} />
          <Field
            label="last activity"
            value={new Date(session.last_activity_at).toLocaleString()}
          />
        </dl>
        {nextStep ? (
          <p className="text-sm">
            <span className="text-muted-foreground">next: </span>
            {nextStep}
          </p>
        ) : null}
      </Link>
    </li>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <span className="flex items-baseline gap-1">
      <span>{label}:</span>
      <span className="text-foreground">{value}</span>
    </span>
  );
}

function badgeVariantForStatus(
  status: SessionRow["status"],
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "active") return "default";
  if (status === "paused") return "secondary";
  if (status === "deleted") return "destructive";
  if (status === "archived") return "secondary";
  return "outline";
}
