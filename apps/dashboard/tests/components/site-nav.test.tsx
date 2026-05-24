import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// usePathname drives the active-link state; next-themes backs the ThemeToggle the
// nav renders. Both are mocked so this stays a fast component-only check.
let mockPathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => mockPathname }));
vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", setTheme: vi.fn() }),
}));

const { SiteNav } = await import("@/components/site-nav");

const SECTIONS = [
  ["Memories", "/"],
  ["Sessions", "/sessions"],
  ["Recall", "/recall"],
  ["Analytics", "/analytics"],
  ["Proposals", "/proposals"],
  ["Archive", "/archive"],
  ["Logs", "/logs"],
  ["Curator", "/curator"],
] as const;

beforeEach(() => {
  mockPathname = "/";
});

describe("SiteNav", () => {
  it("renders a link to every primary section, including Curator", () => {
    render(<SiteNav />);
    for (const [label, href] of SECTIONS) {
      const link = screen.getByRole("link", { name: label });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute("href", href);
    }
  });

  it("marks the section matching the current path with aria-current and not the others", () => {
    mockPathname = "/curator";
    render(<SiteNav />);
    expect(screen.getByRole("link", { name: "Curator" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Memories" })).not.toHaveAttribute("aria-current");
  });

  it("treats a session detail route as the active Sessions section", () => {
    mockPathname = "/sessions/ses_abc";
    render(<SiteNav />);
    expect(screen.getByRole("link", { name: "Sessions" })).toHaveAttribute("aria-current", "page");
  });
});
