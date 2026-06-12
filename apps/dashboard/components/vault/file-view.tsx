"use client";

// The vault file view (rethink T18): rendered markdown with clickable
// wikilinks, the frontmatter property table, and the backlinks pane.
// The write-side chrome (editor, rename/delete) lands with T19.

import Link from "next/link";
import { MarkdownContent } from "@/components/vault/markdown-content";
import type { VaultFile } from "@/components/vault/types";

export function FileView({ file }: { file: VaultFile }) {
  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="font-mono text-sm text-foreground">{file.path}</h2>
        <span className="rounded-sm border border-ink-hairline px-1.5 py-0.5 text-xs uppercase text-muted-foreground">
          {file.kind}
        </span>
      </header>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <article className="rounded-md border bg-card p-6">
          <MarkdownContent body={file.body} links={file.links} />
        </article>
        <aside className="flex flex-col gap-4">
          {file.frontmatter ? <FrontmatterTable frontmatter={file.frontmatter} /> : null}
          <BacklinksPane backlinks={file.backlinks} />
          <p className="text-xs text-muted-foreground">Last modified {file.mtime}</p>
        </aside>
      </div>
    </div>
  );
}

/** Frontmatter as a property table — whatever keys the file carries. */
function FrontmatterTable({ frontmatter }: { frontmatter: Record<string, unknown> }) {
  const entries = Object.entries(frontmatter);
  if (entries.length === 0) return null;
  return (
    <section aria-label="Frontmatter" className="rounded-md border bg-card p-4 text-sm">
      <h3 className="mb-2 text-xs font-medium uppercase text-muted-foreground">Properties</h3>
      <dl className="flex flex-col gap-2">
        {entries.map(([key, value]) => (
          <div key={key} className="flex flex-col">
            <dt className="text-xs text-muted-foreground">{key}</dt>
            <dd className="break-all font-mono text-xs text-foreground">
              {formatFrontmatterValue(value)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function formatFrontmatterValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.length > 0 ? value.join(", ") : "—";
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** The "what links here" pane, from the server-built link index. */
function BacklinksPane({ backlinks }: { backlinks: string[] }) {
  return (
    <section aria-label="Backlinks" className="rounded-md border bg-card p-4 text-sm">
      <h3 className="mb-2 text-xs font-medium uppercase text-muted-foreground">Backlinks</h3>
      {backlinks.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing links here.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {backlinks.map((path) => (
            <li key={path}>
              <Link
                href={`/vault?path=${encodeURIComponent(path)}`}
                className="font-mono text-xs underline"
              >
                {path}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
