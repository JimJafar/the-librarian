// Importing an existing Markdown file as a reference — spec 073 T2 (SC 2, D4).
//
// The web-capture path renders frontmatter from scratch, which is right for a
// scraped article and wrong for a file that already has its own. Importing an
// Obsidian folder must not silently destroy `tags`, `aliases` or a hand-written
// title — the operator's metadata is the reason they kept those files.
//
// So the rule is ADD, NEVER CLOBBER: fill in only the keys that are absent.

import { renderImportedReference } from "@librarian/core";
import matter from "gray-matter";
import { describe, expect, it } from "vitest";

const CAPTURED_AT = "2026-07-25T10:00:00.000Z";

const render = (raw: string, over: Record<string, unknown> = {}) =>
  renderImportedReference({
    raw,
    via: "cli",
    capturedAt: CAPTURED_AT,
    ...over,
  });

const fm = (rendered: string) => matter(rendered).data;
const body = (rendered: string) => matter(rendered).content;

describe("renderImportedReference — preserves what the file already had", () => {
  it("keeps every existing frontmatter key", () => {
    const raw = matter.stringify("The body.", {
      title: "My own title",
      tags: ["obsidian", "spec"],
      aliases: ["thing"],
    });

    const data = fm(render(raw));

    expect(data.title).toBe("My own title");
    expect(data.tags).toEqual(["obsidian", "spec"]);
    expect(data.aliases).toEqual(["thing"]);
  });

  it("never overwrites via, captured_at or source when the file supplies them", () => {
    const raw = matter.stringify("The body.", {
      via: "extension",
      captured_at: "2020-01-01T00:00:00.000Z",
      source: "https://original.example/page",
    });

    const data = fm(render(raw, { source: "/home/jim/notes/thing.md" }));

    expect(data.via).toBe("extension");
    expect(data.captured_at).toBe("2020-01-01T00:00:00.000Z");
    expect(data.source).toBe("https://original.example/page");
  });

  it("preserves the body verbatim", () => {
    const raw = matter.stringify("# Heading\n\nLine one.\n\n- a\n- b\n", { title: "T" });
    expect(body(render(raw)).trim()).toBe("# Heading\n\nLine one.\n\n- a\n- b");
  });
});

describe("renderImportedReference — fills in what is missing", () => {
  it("stamps via, captured_at and source when the file has none", () => {
    const data = fm(render("Just a body, no frontmatter.", { source: "/notes/a.md" }));

    expect(data.via).toBe("cli");
    expect(data.captured_at).toBe(CAPTURED_AT);
    expect(data.source).toBe("/notes/a.md");
  });

  it("derives a missing title from the first H1", () => {
    const data = fm(render("# Deploy policy\n\nNever on a Friday.\n"));
    expect(data.title).toBe("Deploy policy");
  });

  it("prefers the file's own title over its H1", () => {
    const raw = matter.stringify("# An H1\n\nbody", { title: "Frontmatter wins" });
    expect(fm(render(raw)).title).toBe("Frontmatter wins");
  });

  it("falls back to the supplied title when there is neither", () => {
    const data = fm(render("no heading here", { fallbackTitle: "rfc-7231" }));
    expect(data.title).toBe("rfc-7231");
  });

  it("ends up with a title even with nothing to go on", () => {
    expect(fm(render("body only")).title).toBeTruthy();
  });

  it("ignores a heading that is not the first line's H1", () => {
    const data = fm(render("Some intro.\n\n## Not an H1\n", { fallbackTitle: "fallback" }));
    expect(data.title).toBe("fallback");
  });
});

describe("renderImportedReference — round-trips", () => {
  it("re-importing its own output changes nothing", () => {
    const once = render("# Title\n\nbody\n", { source: "/notes/a.md" });
    const twice = renderImportedReference({
      raw: once,
      via: "dashboard",
      capturedAt: "2099-01-01T00:00:00.000Z",
      source: "/somewhere/else.md",
    });
    expect(fm(twice)).toEqual(fm(once));
  });
});
