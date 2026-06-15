"use client";

import Link from "next/link";
import { useState } from "react";
import { Pill } from "@/components/ui-v2/pill";
import { SectionLabel } from "@/components/ui-v2/section-label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui-v2/table";
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
      <div className="flex flex-wrap items-end gap-4 text-sm">
        <label className="flex flex-col gap-1.5">
          <SectionLabel as="span">Project</SectionLabel>
          <input
            className="border border-ink-hairline bg-transparent px-2 py-1.5 font-mono text-xs text-foreground placeholder:text-foreground/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink-accent pointer-coarse:min-h-11 pointer-coarse:text-sm"
            placeholder="filter project_key"
            value={projectKey}
            onChange={(e) => setProjectKey(e.target.value)}
          />
        </label>
        <label className="flex cursor-pointer items-center gap-2 pb-1.5 text-foreground/70 pointer-coarse:min-h-11">
          <input
            type="checkbox"
            checked={includeClaimed}
            onChange={(e) => setIncludeClaimed(e.target.checked)}
            className="accent-ink-accent"
          />
          Include claimed
        </label>
      </div>

      {result.isLoading ? (
        <p className="text-sm text-foreground/60">Loading handoffs…</p>
      ) : result.isError ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          Failed to load handoffs: {result.error?.message ?? "unknown error"}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-foreground/60">
          No handoffs{includeClaimed ? "" : " unclaimed"}
          {projectKey ? ` for project ${projectKey}` : ""}.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Project</TableHead>
              <TableHead>From</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.handoff_id}>
                <TableCell>
                  <Link
                    href={`/handoffs/${row.handoff_id}`}
                    className="font-medium text-ink-accent underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent"
                  >
                    {row.title}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-xs text-foreground/75">
                  {row.project_key ?? "—"}
                </TableCell>
                <TableCell className="font-mono text-xs text-foreground/75">
                  {row.created_in_harness ?? "—"}
                </TableCell>
                <TableCell className="font-mono text-xs text-foreground/75">
                  {row.created_at}
                </TableCell>
                <TableCell>
                  {row.claimed_at ? (
                    <Pill variant="muted">claimed</Pill>
                  ) : (
                    <Pill variant="accent">unclaimed</Pill>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
