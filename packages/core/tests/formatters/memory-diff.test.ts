// unifiedMemoryDiff — server-side old→new memory diff (spec T3 / D3).
//
// Diffs the rendered doc text `# ${title}\n\n${body}` of an old vs proposed
// memory with jsdiff's createTwoFilesPatch, then strips jsdiff's `Index:` +
// `===` preamble so the returned string starts at the `--- `/`+++ `/`@@` hunk
// headers the dashboard's DiffView classifies. Identical input → "".
import { unifiedMemoryDiff } from "@librarian/core";
import { describe, expect, it } from "vitest";

describe("unifiedMemoryDiff", () => {
  it("renders +/- lines for a changed body with no jsdiff preamble", () => {
    const oldMem = { title: "Coffee", body: "Espresso, no sugar." };
    const newMem = { title: "Coffee", body: "Espresso, one sugar." };

    const diff = unifiedMemoryDiff(oldMem, newMem);
    const lines = diff.split("\n");

    // A changed body yields ≥1 addition and ≥1 deletion line.
    expect(lines.some((l) => l.startsWith("+"))).toBe(true);
    expect(lines.some((l) => l.startsWith("-"))).toBe(true);

    // The jsdiff preamble (`Index:` line + `===` separator) is stripped so the
    // string DiffView receives starts at a header it actually classifies.
    expect(lines.some((l) => l.startsWith("Index:"))).toBe(false);
    expect(lines.some((l) => l.startsWith("==="))).toBe(false);

    // The first non-empty line is one of the headers DiffView dims.
    const first = lines.find((l) => l.length > 0);
    expect(first?.startsWith("--- ") || first?.startsWith("@@")).toBe(true);
  });

  it("diffs the title as well as the body", () => {
    const oldMem = { title: "Old title", body: "Same body." };
    const newMem = { title: "New title", body: "Same body." };

    const diff = unifiedMemoryDiff(oldMem, newMem);

    expect(diff).toContain("-# Old title");
    expect(diff).toContain("+# New title");
  });

  it("returns an empty string when old and new render identically", () => {
    const mem = { title: "Stable", body: "Unchanged body." };
    expect(unifiedMemoryDiff(mem, { ...mem })).toBe("");
  });
});
