import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_DOCS_URL, DOCS_SLUGS, docsSlugForPath, docsUrlForPath } from "@/lib/docs-map";

// Cross-surface link guard (docs-site spec T4.1). The dashboard deep-links into
// the docs site; every target must resolve to a real docs page, or a rename /
// removal would 404 in the wild. The docs content lives in the sibling app —
// anchor the path to this file (cwd-independent), not process.cwd().
const here = path.dirname(fileURLToPath(import.meta.url)); // apps/dashboard/tests
const DOCS_CONTENT = path.resolve(here, "../../docs/src/content/docs");
// A slug resolves to either `<slug>.md(x)` or an index route `<slug>/index.md(x)`
// (e.g. the "dashboard" landing is dashboard/index.md).
const pageExists = (slug: string): boolean =>
  [`${slug}.md`, `${slug}.mdx`, `${slug}/index.md`, `${slug}/index.mdx`].some((rel) =>
    fs.existsSync(path.join(DOCS_CONTENT, rel)),
  );

describe("dashboard → docs cross-surface links", () => {
  it("every deep-linkable docs slug is a real page", () => {
    expect(DOCS_SLUGS.length).toBeGreaterThan(0);
    for (const slug of DOCS_SLUGS) {
      expect(pageExists(slug), `no docs page for slug '${slug}'`).toBe(true);
    }
  });

  it("maps representative routes (incl. /settings/* and /handoffs/:id) to real pages", () => {
    for (const route of ["/", "/memories", "/settings/tokens", "/handoffs/abc-123", "/unknown"]) {
      expect(pageExists(docsSlugForPath(route)), `route ${route} mapped to a missing page`).toBe(
        true,
      );
    }
  });

  it("returns null for an empty base (callers supply the default)", () => {
    expect(docsUrlForPath(undefined, "/memories")).toBeNull();
    expect(docsUrlForPath("", "/memories")).toBeNull();
  });

  it("defaults to the public docs site", () => {
    expect(DEFAULT_DOCS_URL).toBe("https://librarian-docs.codeministry.net");
    expect(docsUrlForPath(DEFAULT_DOCS_URL, "/memories")).toBe(
      "https://librarian-docs.codeministry.net/dashboard/memories/",
    );
  });

  it("builds an absolute docs URL when a base is configured", () => {
    expect(docsUrlForPath("https://docs.example.com", "/memories")).toBe(
      "https://docs.example.com/dashboard/memories/",
    );
    // A trailing slash on the base is normalised.
    expect(docsUrlForPath("https://docs.example.com/", "/")).toBe(
      "https://docs.example.com/dashboard/vault/",
    );
  });
});
