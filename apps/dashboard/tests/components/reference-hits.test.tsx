import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

// ReferenceHits is the pure presentational half of the Memories → References
// tab: it renders what `search_references` returned, with the loading / error /
// empty states. The empty state must tell "no references filed" (searched 0)
// apart from "filed but none matched" (searched > 0, zero hits) — the whole
// point of the diagnostic.
const { ReferenceHits } = await import("@/components/memories/reference-hits");

function hit(over: Record<string, unknown> = {}) {
  return {
    id: "references/AI/Gentle Codeing.md",
    score: 0.0328,
    // Section deliberately omits the phrase "Gentle coding" so the anchor is the
    // only element carrying it (keeps getByText unambiguous).
    section: "Write the smallest change that teaches the model.",
    anchor: "Gentle coding",
    startChar: 0,
    endChar: 62,
    ...over,
  };
}

describe("ReferenceHits", () => {
  it("renders each hit with its path, score, anchor and section", () => {
    render(
      <ReferenceHits
        result={{ query: "gentle coding", references: [hit()], searched: 12 }}
        isLoading={false}
        error={null}
      />,
    );
    // Every value is also echoed in the raw-JSON disclosure (in the DOM even
    // when collapsed), so scope the card assertions to the results list.
    const list = within(screen.getByRole("list"));
    expect(list.getByText("references/AI/Gentle Codeing.md")).toBeInTheDocument();
    expect(list.getByText("score 0.0328")).toBeInTheDocument();
    expect(list.getByText(/^Gentle coding/)).toBeInTheDocument();
    expect(list.getByText(/smallest change that teaches/)).toBeInTheDocument();
  });

  it("links each hit path into the vault explorer (/?path=...)", () => {
    render(
      <ReferenceHits
        result={{ query: "gentle coding", references: [hit()], searched: 12 }}
        isLoading={false}
        error={null}
      />,
    );
    const link = screen.getByRole("link", { name: /Gentle Codeing\.md/ });
    expect(link).toHaveAttribute(
      "href",
      `/?path=${encodeURIComponent("references/AI/Gentle Codeing.md")}`,
    );
  });

  it("distinguishes an empty vault from a no-match result", () => {
    const { rerender } = render(
      <ReferenceHits
        result={{ query: "anything", references: [], searched: 0 }}
        isLoading={false}
        error={null}
      />,
    );
    // searched 0 → there are simply no reference docs filed.
    expect(screen.getByText(/no reference documents/i)).toBeInTheDocument();

    rerender(
      <ReferenceHits
        result={{ query: "gentle coding", references: [], searched: 12 }}
        isLoading={false}
        error={null}
      />,
    );
    // searched 12, zero hits → they exist but none matched (the real diagnosis).
    expect(screen.getByText(/12/)).toBeInTheDocument();
    expect(screen.getByText(/none matched/i)).toBeInTheDocument();
  });

  it("exposes the exact agent payload under a raw-JSON disclosure", () => {
    render(
      <ReferenceHits
        result={{ query: "gentle coding", references: [hit()], searched: 12 }}
        isLoading={false}
        error={null}
      />,
    );
    // The disclosure shows { references: [...] } — what the agent actually gets,
    // not the dashboard-only `searched` field.
    const raw = screen.getByTestId("references-raw-json").textContent ?? "";
    expect(raw).toContain('"references"');
    expect(raw).toContain("references/AI/Gentle Codeing.md");
    expect(raw).not.toContain("searched");
  });

  it("renders the error state", () => {
    render(<ReferenceHits result={null} isLoading={false} error="index boom" />);
    expect(screen.getByRole("alert")).toHaveTextContent(/index boom/);
  });

  it("prompts before any search has run", () => {
    render(<ReferenceHits result={null} isLoading={false} error={null} />);
    expect(screen.getByText(/run a query/i)).toBeInTheDocument();
  });
});
