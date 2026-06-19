import type { ReferenceHit } from "@/components/memories/types";

// The result half of the Memories → References tab. Pure + presentational
// (the sibling of MemoriesList): it renders exactly what search_references
// returned, so the operator sees what an agent sees. The empty state tells
// "no references filed" (searched 0) apart from "filed but none matched"
// (searched > 0, zero hits) — the diagnostic the tab exists for.

export interface ReferenceSearchResult {
  query: string;
  references: ReferenceHit[];
  searched: number;
}

const META = "font-mono text-[11px] uppercase tracking-wider text-foreground/45";

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

export function ReferenceHits({
  result,
  isLoading,
  error,
}: {
  result: ReferenceSearchResult | null;
  isLoading: boolean;
  error: string | null;
}) {
  if (error) {
    return (
      <p
        role="alert"
        className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
      >
        Reference search failed: {error}. Try again, or refine the query.
      </p>
    );
  }

  if (isLoading) {
    return <p className="text-sm text-foreground/55">Searching references…</p>;
  }

  if (!result) {
    return (
      <p className="text-sm text-foreground/55">
        Run a query above to see what agents retrieve from{" "}
        <span className="font-mono text-foreground/80">references/</span>.
      </p>
    );
  }

  const { query, references, searched } = result;

  if (references.length === 0) {
    return (
      <p className="text-sm text-foreground/60">
        {searched === 0 ? (
          <>
            No reference documents in the vault&rsquo;s{" "}
            <span className="font-mono text-foreground/80">references/</span> folder yet — nothing
            to search.
          </>
        ) : (
          <>
            Searched {searched} reference{plural(searched)}, none matched &ldquo;{query}&rdquo;. The
            document may be filed under a different word, or not in this server&rsquo;s vault at
            all.
          </>
        )}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        role="status"
        className="border border-ink-accent/40 bg-ink-accent/[0.06] px-3 py-2 text-sm text-foreground"
      >
        Showing {references.length} of {searched} reference{plural(searched)} for &ldquo;{query}
        &rdquo;, best-ranked first.
      </div>

      <ol className="flex min-w-0 flex-col gap-3">
        {references.map((ref, i) => (
          <li
            key={`${ref.id}#${i}`}
            className="flex min-w-0 flex-col gap-2 border border-ink-hairline p-3"
          >
            <div className="flex items-baseline justify-between gap-3">
              <a
                href={`/?path=${encodeURIComponent(ref.id)}`}
                className="truncate font-mono text-sm text-ink-accent hover:underline"
                title={ref.id}
              >
                {ref.id}
              </a>
              <span className="shrink-0 font-mono text-[11px] text-foreground/55">
                score {ref.score.toFixed(4)}
              </span>
            </div>

            <div className={META}>
              {ref.anchor ? ref.anchor : "(preamble)"}
              {typeof ref.startChar === "number" && typeof ref.endChar === "number"
                ? ` · chars ${ref.startChar}–${ref.endChar}`
                : ""}
            </div>

            <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground/80">
              {ref.section}
            </pre>
          </li>
        ))}
      </ol>

      <details className="border border-ink-hairline">
        <summary className="cursor-pointer select-none px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-foreground/55">
          Raw payload — what the agent receives
        </summary>
        <pre
          data-testid="references-raw-json"
          className="overflow-x-auto border-t border-ink-hairline px-3 py-2 font-mono text-xs text-foreground/70"
        >
          {JSON.stringify({ references }, null, 2)}
        </pre>
      </details>
    </div>
  );
}
