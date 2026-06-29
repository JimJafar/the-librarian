// Drift-guard logic for the generated reference (docs-site spec criterion #5 /
// T2.3). `pnpm check:docs` regenerates the reference from canonical source and
// compares it to the committed pages; any divergence fails CI, naming the stale
// page and the fix command. CI runs it AFTER the build so it can never pass
// against stale dist (K8). This suite pins the comparison logic and asserts the
// committed pages are currently in sync.

import { describe, expect, it } from "vitest";
import { findStaleReferencePages } from "../scripts/check-docs.mjs";

describe("check:docs drift-guard", () => {
  it("reports no drift for the pages committed in this repo", () => {
    // Reads the real generated pages off disk against a fresh regeneration.
    expect(findStaleReferencePages()).toEqual([]);
  });

  it("treats a byte-for-byte match (modulo trailing newline) as in sync", () => {
    const reference = { "a.md": "hello\nworld" };
    expect(findStaleReferencePages(reference, () => "hello\nworld\n")).toEqual([]);
  });

  it("flags a page whose committed content differs", () => {
    const reference = { "a.md": "expected", "b.md": "also" };
    const onDisk = { "a.md": "expected\n", "b.md": "TAMPERED\n" };
    expect(findStaleReferencePages(reference, (p) => onDisk[p])).toEqual(["b.md"]);
  });

  it("flags a page that is missing from disk", () => {
    const reference = { "gone.md": "content" };
    expect(
      findStaleReferencePages(reference, () => {
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      }),
    ).toEqual(["gone.md"]);
  });
});
