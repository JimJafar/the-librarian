"use client";

// Rendered markdown for the vault file view (rethink T18). react-markdown is
// the dashboard's first markdown renderer — chosen as the lightest standard
// React option (pure render-to-elements, no dangerouslySetInnerHTML, so vault
// content can't inject markup).
//
// Wikilinks aren't markdown, so the body is pre-processed first: every
// [[target]], [[target|alias]], [[target#heading]] (and ![[embed]]) whose
// target the server resolved becomes a regular markdown link to
// `/vault?path=…`; a dangling link stays as its literal [[…]] text. The
// resolution map comes from the read procedure — the same alias/slug logic the
// wikilink machinery uses server-side.

import Link from "next/link";
import ReactMarkdown from "react-markdown";

// Mirrors the core wikilink scanner: (!?) embed · target (no [ ] | #) ·
// optional #heading · optional |alias.
const WIKILINK = /(!?)\[\[([^[\]|#]+)(#[^[\]|]+)?(\|[^[\]]+)?\]\]/g;

/** Rewrite resolved wikilinks into markdown links; leave dangling ones verbatim. */
export function rewriteWikilinks(
  body: string,
  links: { target: string; path: string | null }[],
): string {
  const byTarget = new Map(links.map((link) => [link.target.trim().toLowerCase(), link.path]));
  return body.replace(
    WIKILINK,
    (raw, _embed: string, target: string, heading?: string, alias?: string) => {
      const path = byTarget.get(target.trim().toLowerCase());
      if (!path) return raw; // dangling — keep the literal [[…]] so it's visibly unresolved
      const label = alias ? alias.slice(1).trim() : `${target.trim()}${heading ?? ""}`;
      return `[${label}](/vault?path=${encodeURIComponent(path)})`;
    },
  );
}

export function MarkdownContent({
  body,
  links,
}: {
  body: string;
  links: { target: string; path: string | null }[];
}) {
  // The Reading Room: Newsreader body at 16px, Fraunces headings, IBM Plex
  // Mono for code, capped at 68ch — the editorial reading ramp lives in
  // `.vault-prose` (globals.css) so the dashboard's dense 14px UI body
  // stays untouched. Replaces the old `prose prose-sm` no-ops (the
  // typography plugin isn't installed).
  return (
    <div className="vault-prose min-w-0">
      <ReactMarkdown
        components={{
          a: ({ href, children }) =>
            href?.startsWith("/vault") ? (
              <Link href={href}>{children}</Link>
            ) : (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            ),
        }}
      >
        {rewriteWikilinks(body, links)}
      </ReactMarkdown>
    </div>
  );
}
