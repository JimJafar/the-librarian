"use client";

import { Button } from "@/components/ui-v2/button";
import { Pill } from "@/components/ui-v2/pill";
import { trpc } from "@/lib/trpc-client";

const PAGE_SIZE = 50;

export function EventsStream({ sessionId }: { sessionId: string }) {
  const events = trpc.sessions.events.useQuery({ session_id: sessionId, limit: PAGE_SIZE });
  const rows = events.data?.events ?? [];

  if (events.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading events…</p>;
  }
  if (events.isError) {
    return (
      <p className="text-sm text-destructive">Failed to load events: {events.error.message}</p>
    );
  }
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No events recorded yet.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-2">
        {rows.map((event) => (
          <li key={event.id} className="rounded-md border bg-background p-3 text-sm">
            <div className="flex items-baseline justify-between gap-2">
              <div className="flex items-center gap-2">
                <Pill>{event.type}</Pill>
                <span className="text-xs text-muted-foreground">{event.agent_id ?? "—"}</span>
              </div>
              <span className="text-xs text-muted-foreground">
                {new Date(event.created_at).toLocaleString()}
              </span>
            </div>
            <pre className="mt-2 overflow-x-auto rounded-md bg-muted/40 p-2 text-xs">
              {JSON.stringify(event.payload, null, 2)}
            </pre>
          </li>
        ))}
      </ul>
      <Button variant="ghost" onClick={() => events.refetch()}>
        Refresh
      </Button>
    </div>
  );
}
