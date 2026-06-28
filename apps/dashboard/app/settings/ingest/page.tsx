// Captures (ingest-log) panel (reference-ingest spec criterion 15/22; D7).
//
// Lists recent reference-capture attempts from the browser extension / mobile
// share. Failures surface their redacted error + source so the operator can
// revisit and capture manually; successes link to the filed reference in the
// vault explorer. Read-only — the capture clients write the log over /ingest.

import { EmptyState } from "@/components/brand/empty-state";
import { IngestLog, type IngestRow } from "@/components/ingest/ingest-log";
import { serverTRPC } from "@/lib/trpc-server";

export const metadata = { title: "Captures · Librarian" };
export const dynamic = "force-dynamic";

export default async function IngestPage() {
  let rows: IngestRow[] = [];
  let error: string | null = null;
  try {
    rows = (await serverTRPC.ingest.recent.query({ limit: 100 })) as IngestRow[];
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const failures = rows.filter((r) => r.status === "failed").length;

  return (
    <main className="flex flex-col gap-5 p-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-xl text-foreground">Captures</h1>
        <p className="max-w-[65ch] text-sm text-foreground/60">
          Every reference your devices have sent in. A failed capture keeps its source so you can
          revisit the page and file it by hand; a saved one links straight to the reference in the
          vault.
        </p>
      </header>

      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          Failed to load captures: {error}
        </p>
      ) : null}

      {!error && rows.length === 0 ? (
        <EmptyState title="No captures yet">
          <p>
            Once you connect the browser extension or your phone, the articles you share will appear
            here — pending, saved, or failed, newest first.
          </p>
        </EmptyState>
      ) : null}

      {rows.length > 0 ? (
        <section
          className="border border-ink-hairline bg-ink-surface p-4"
          aria-label="Recent captures"
        >
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="font-display text-lg text-foreground">Recent captures</h2>
            {failures > 0 ? (
              <span className="text-xs text-foreground/60">
                {failures} need{failures === 1 ? "s" : ""} attention
              </span>
            ) : null}
          </div>
          <IngestLog rows={rows} />
        </section>
      ) : null}
    </main>
  );
}
