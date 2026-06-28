// Pure presentation helpers for the ingest-log (Captures) panel — kept free of
// React so they unit-test in plain Node.

export type IngestStatus = "pending" | "success" | "failed";

/**
 * Which Pill variant a capture status wears. `accent` (the rubric) is spent on
 * the one state that needs the operator's attention — a failure; success is the
 * neutral default; pending is `muted` (the secondary/in-flight hue). This keeps
 * the One-Pen rule: a row that failed is the only one carrying the accent.
 */
export function statusPillVariant(status: IngestStatus): "default" | "accent" | "muted" {
  switch (status) {
    case "failed":
      return "accent";
    case "pending":
      return "muted";
    default:
      return "default";
  }
}

/** Human label for a status (the machine value stays in the data; this is prose). */
export function statusLabel(status: IngestStatus): string {
  switch (status) {
    case "failed":
      return "Failed";
    case "pending":
      return "Pending";
    default:
      return "Saved";
  }
}

/**
 * The vault-explorer deep link for a successful capture's result path, or null
 * when there is no path (a pending/failed row). The explorer reads `?path=` on
 * the root route, so a success row links straight to its filed reference.
 */
export function vaultPathHref(resultPath: string | null | undefined): string | null {
  if (!resultPath) return null;
  return `/?path=${encodeURIComponent(resultPath)}`;
}
