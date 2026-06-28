import { describe, expect, it } from "vitest";
import { buildPayload } from "../src/lib/payload.js";
import type { Extraction } from "../src/lib/types.js";

describe("buildPayload", () => {
  const url = "https://example.com/article";

  it("produces the exact /ingest body the server contract expects", () => {
    const extraction: Extraction = {
      title: "A Title",
      content: "# A Title\n\nBody in markdown.",
      site: "Example",
      byline: "Jane Doe",
    };

    expect(buildPayload(extraction, url)).toEqual({
      url,
      title: "A Title",
      content: "# A Title\n\nBody in markdown.",
      via: "extension",
      site: "Example",
      byline: "Jane Doe",
    });
  });

  it("omits site and byline entirely when the extraction lacks them", () => {
    const extraction: Extraction = { title: "No Meta", content: "body" };
    const payload = buildPayload(extraction, url);

    expect(payload).toEqual({ url, title: "No Meta", content: "body", via: "extension" });
    expect("site" in payload).toBe(false);
    expect("byline" in payload).toBe(false);
  });

  it("omits site and byline when they are present but blank/whitespace", () => {
    const extraction: Extraction = { title: "T", content: "b", site: "   ", byline: "" };
    const payload = buildPayload(extraction, url);

    expect("site" in payload).toBe(false);
    expect("byline" in payload).toBe(false);
  });

  it("trims the title but leaves the markdown content untouched", () => {
    const extraction: Extraction = { title: "  Spaced  ", content: "  keep leading space  " };
    const payload = buildPayload(extraction, url);

    expect(payload.title).toBe("Spaced");
    expect(payload.content).toBe("  keep leading space  ");
  });

  it("always stamps via: extension", () => {
    const payload = buildPayload({ title: "t", content: "c" }, url);
    expect(payload.via).toBe("extension");
  });
});
