"use client";

import Link from "next/link";
import { useState } from "react";
import { isStale, type SessionRow } from "./types";
import { Input } from "@/components/ui-v2/input";
import { Pill } from "@/components/ui-v2/pill";
import { trpc } from "@/lib/trpc-client";

const PAGE_LIMIT = 50;

export function SessionsListView() {
  const [query, setQuery] = useState("");
  const [projectKey, setProjectKey] = useState("");
  const [harness, setHarness] = useState("");
  const [includeEnded, setIncludeEnded] = useState(false);

  const hasQuery = query.trim().length > 0;

  // D1.2 — data-driven dropdowns populated by sessions.distinctValues.
  // include_ended is wired so the dropdown widens when the user is also
  // scoping the list to ended sessions.
  const projectQuery = trpc.sessions.distinctValues.useQuery({
    field: "project_key",
    include_ended: includeEnded,
  });
  const harnessQuery = trpc.sessions.distinctValues.useQuery({
    field: "current_harness",
    include_ended: includeEnded,
  });

  // Branch between `.list` and `.search`: the store's search short-circuits
  // to an empty result when `query` is blank, so we use `.list` for the
  // default page load and switch to `.search` only when there's a query.
  const listInput = {
    limit: PAGE_LIMIT,
    include_ended: includeEnded,
    ...(projectKey ? { project_key: projectKey } : {}),
    ...(harness ? { harness } : {}),
  } as Parameters<typeof trpc.sessions.list.useQuery>[0];

  const searchInput = {
    limit: PAGE_LIMIT,
    include_ended: includeEnded,
    query: query.trim(),
    ...(projectKey ? { project_key: projectKey } : {}),
  } as Parameters<typeof trpc.sessions.search.useQuery>[0];

  const listResult = trpc.sessions.list.useQuery(listInput, { enabled: !hasQuery });
  const searchResult = trpc.sessions.search.useQuery(searchInput, { enabled: hasQuery });
  const active = hasQuery ? searchResult : listResult;
  const sessions = (active.data?.sessions ?? []) as SessionRow[];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 rounded-md border bg-card p-3 text-sm md:grid-cols-[1fr_1fr_1fr_auto]">
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
          <select
            aria-label="Filter by project"
            value={projectKey}
            onChange={(e) => setProjectKey(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2"
          >
            <option value="">(any)</option>
            {(projectQuery.data ?? []).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Harness</span>
          <select
            aria-label="Filter by harness"
            value={harness}
            onChange={(e) => setHarness(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2"
          >
            <option value="">(any)</option>
            {(harnessQuery.data ?? []).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={includeEnded}
            onChange={(e) => setIncludeEnded(e.target.checked)}
          />
          <span>Include ended</span>
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
          <Pill variant={pillVariantForStatus(session.status)}>{session.status}</Pill>
          {stale ? <Pill variant="accent">stale</Pill> : null}
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

function pillVariantForStatus(status: SessionRow["status"]): "default" | "accent" | "muted" {
  if (status === "active") return "accent";
  if (status === "paused") return "muted";
  return "default";
}
