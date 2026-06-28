// The Captures (ingest-log) panel (reference-ingest spec criterion 15/22; D7).
//
// A dense, read-only table of recent capture attempts. A FAILED row shows its
// (already-redacted) error and the source URL so the operator can revisit the
// page and capture it manually. A SUCCESS row links its filed reference into the
// vault explorer. Presentational only — the data is fetched server-side and the
// rows arrive already redacted (D25), so nothing here needs client state.

import Link from "next/link";
import { Pill } from "@/components/ui-v2/pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui-v2/table";
import {
  type IngestStatus,
  statusLabel,
  statusPillVariant,
  vaultPathHref,
} from "@/lib/ingest-format";

export interface IngestRow {
  id: string;
  source: string;
  via: string;
  status: IngestStatus;
  error?: string;
  result_path?: string;
  created_at: string;
}

export function IngestLog({ rows }: { rows: IngestRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[7rem]">Status</TableHead>
          <TableHead className="w-[6rem]">Via</TableHead>
          <TableHead className="w-[14rem]">Captured</TableHead>
          <TableHead>Source</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const href = vaultPathHref(row.result_path);
          return (
            <TableRow key={row.id} className="align-top">
              <TableCell className="py-2">
                <Pill variant={statusPillVariant(row.status)}>{statusLabel(row.status)}</Pill>
              </TableCell>
              <TableCell className="py-2 font-mono text-xs text-foreground/70">{row.via}</TableCell>
              <TableCell className="py-2 font-mono text-xs text-foreground/70">
                {row.created_at}
              </TableCell>
              <TableCell className="py-2">
                <div className="flex flex-col gap-1">
                  <span className="break-all font-mono text-xs text-foreground">{row.source}</span>
                  {row.status === "failed" && row.error ? (
                    <span className="break-words text-xs text-destructive">{row.error}</span>
                  ) : null}
                  {row.status === "success" && href ? (
                    <Link
                      href={href}
                      className="w-fit break-all font-mono text-xs text-ink-accent underline underline-offset-2 hover:no-underline"
                    >
                      {row.result_path}
                    </Link>
                  ) : null}
                  {row.status === "success" && !href ? (
                    <span className="break-all font-mono text-xs text-foreground/60">
                      {row.result_path}
                    </span>
                  ) : null}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
