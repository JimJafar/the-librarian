import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// usePathname drives which docs page the link targets.
let mockPathname = "/memories";
vi.mock("next/navigation", () => ({ usePathname: () => mockPathname }));

const { DocsLink } = await import("@/components/docs-link");

const ORIGINAL = process.env.NEXT_PUBLIC_DOCS_URL;

beforeEach(() => {
  mockPathname = "/memories";
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_DOCS_URL;
  else process.env.NEXT_PUBLIC_DOCS_URL = ORIGINAL;
});

describe("DocsLink", () => {
  it("renders nothing when no docs base URL is configured (pre-go-live)", () => {
    delete process.env.NEXT_PUBLIC_DOCS_URL;
    const { container } = render(<DocsLink />);
    expect(container).toBeEmptyDOMElement();
  });

  it("deep-links to the docs page for the current route when configured", () => {
    process.env.NEXT_PUBLIC_DOCS_URL = "https://docs.example.com";
    render(<DocsLink />);
    const link = screen.getByRole("link", { name: "Docs" });
    expect(link).toHaveAttribute("href", "https://docs.example.com/dashboard/memories/");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  it("follows the route — a settings tab links to the settings page", () => {
    process.env.NEXT_PUBLIC_DOCS_URL = "https://docs.example.com";
    mockPathname = "/settings/tokens";
    render(<DocsLink />);
    expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute(
      "href",
      "https://docs.example.com/dashboard/settings/",
    );
  });
});
