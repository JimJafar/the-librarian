// Unified diff as a <pre> with per-line +/- colouring. No diff library —
// react-markdown / dashboard's existing posture is "render what we get from
// the server, no client transform beyond presentation". Shared between the
// file-history accordion (per-file diffs) and the activity-feed accordion
// (per-commit, per-file diffs).
//
// Editorial palette: verdigris wash for additions (positive rubric), red
// ochre wash for deletions (destructive rubric), foreground/55 for hunk
// markers and diff/index/+++/--- headers, foreground/85 for context lines.
// Data-content driving colour, not chrome — the "two colours per surface"
// guidance applies to design ink, not to a syntactically-mandated diff.

export function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) {
    return <p className="text-sm text-foreground/60">No changes — versions are identical.</p>;
  }
  return (
    <pre
      aria-label="Unified diff"
      className="max-w-full overflow-x-auto border border-ink-hairline bg-foreground/[0.03] p-3 font-mono text-xs leading-5"
    >
      {diff.split("\n").map((line, index) => (
        <span key={index} className={`block whitespace-pre-wrap ${diffLineClass(line)}`}>
          {line || " "}
        </span>
      ))}
    </pre>
  );
}

function diffLineClass(line: string): string {
  // Headers first so '+++' / '---' don't fall through into the addition /
  // deletion branches below.
  if (line.startsWith("+++") || line.startsWith("---")) return "text-foreground/55";
  if (line.startsWith("@@")) return "text-foreground/55";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "text-foreground/55";
  if (line.startsWith("new file mode") || line.startsWith("deleted file mode"))
    return "text-foreground/55";
  if (line.startsWith("rename ") || line.startsWith("similarity ")) return "text-foreground/55";
  if (line.startsWith("+")) return "bg-ink-accent/[0.10] text-foreground";
  if (line.startsWith("-")) return "bg-destructive/[0.10] text-destructive";
  return "text-foreground/85";
}
