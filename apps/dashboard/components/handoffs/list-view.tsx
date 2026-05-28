"use client";

import Link from "next/link";
import { useState } from "react";
import { trpc } from "@/lib/trpc-client";

const PAGE_LIMIT = 50;

export function HandoffsListView() {
  const [includeClaimed, setIncludeClaimed] = useState(false);
  const [projectKey, setProjectKey] = useState("");

  const result = trpc.handoffs.list.useQuery({
    limit: PAGE_LIMIT,
    include_claimed: includeClaimed,
    ...(projectKey ? { project_key: projectKey } : {}),
  });

  const rows = result.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-4 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Project</span>
          <input
            className="rounded-md border bg-background px-2 py-1 font-mono"
            placeholder="filter project_key"
            value={projectKey}
            onChange={(e) => setProjectKey(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={includeClaimed}
            onChange={(e) => setIncludeClaimed(e.target.checked)}
          />
          Include claimed
        </label>
      </div>

      {result.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No handoffs.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase text-muted-foreground">
              <th className="py-2">Title</th>
              <th className="py-2">Project</th>
              <th className="py-2">From</th>
              <th className="py-2">Created</th>
              <th className="py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.handoff_id} className="border-b hover:bg-accent/50">
                <td className="py-2">
                  <Link href={`/handoffs/${row.handoff_id}`} className="font-medium underline">
                    {row.title}
                  </Link>
                </td>
                <td className="py-2 font-mono text-xs">{row.project_key ?? "—"}</td>
                <td className="py-2 font-mono text-xs">{row.created_in_harness ?? "—"}</td>
                <td className="py-2 font-mono text-xs">{row.created_at}</td>
                <td className="py-2 text-xs">{row.claimed_at ? "claimed" : "unclaimed"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
