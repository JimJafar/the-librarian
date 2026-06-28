// Deterministic unit test of the extraction WRAPPER's field mapping, with
// Defuddle mocked. This pins the contract our wrapper owns — which Defuddle
// fields map to which Extraction fields, trimming, and the omit-when-blank rule —
// independent of Defuddle's DOM-scoring (which needs a real browser; see
// extract.test.ts and the README's human-verification step).

import { beforeEach, describe, expect, it, vi } from "vitest";

const parse = vi.fn();

vi.mock("defuddle", () => ({
  default: class FakeDefuddle {
    parse() {
      return parse();
    }
  },
}));

// Imported after the mock is registered (vi.mock is hoisted, but keep it explicit).
const { extractArticle } = await import("../src/lib/extract.js");

beforeEach(() => {
  parse.mockReset();
});

describe("extractArticle field mapping", () => {
  it("maps title←title, content←content, site←site, byline←author", () => {
    parse.mockReturnValue({
      title: "Mapped Title",
      content: "# Mapped Title\n\nmarkdown body",
      site: "The Reading Room",
      author: "Eleanor Ash",
    });

    expect(extractArticle({} as unknown as Document)).toEqual({
      title: "Mapped Title",
      content: "# Mapped Title\n\nmarkdown body",
      site: "The Reading Room",
      byline: "Eleanor Ash",
    });
  });

  it("trims the title/site/byline and omits site/byline when blank", () => {
    parse.mockReturnValue({
      title: "  Spaced  ",
      content: "body",
      site: "   ",
      author: "",
    });

    const extraction = extractArticle({} as unknown as Document);
    expect(extraction.title).toBe("Spaced");
    expect("site" in extraction).toBe(false);
    expect("byline" in extraction).toBe(false);
  });

  it("tolerates missing fields from Defuddle (defensive defaults)", () => {
    parse.mockReturnValue({});
    expect(extractArticle({} as unknown as Document)).toEqual({ title: "", content: "" });
  });
});
