// VersionBadge component tests.
//
// Mock the tRPC `health.info` query so the component receives synthetic
// status payloads. We assert the visible label, the dot's status data-attr
// (drives the colour), the link href, and the title tooltip.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const infoMock = vi.fn();

vi.mock("@/lib/trpc-client", () => ({
  trpc: {
    health: {
      info: { useQuery: (...args: unknown[]) => infoMock(...args) },
    },
  },
}));

const { VersionBadge } = await import("@/components/version-badge");

function setup(data: unknown) {
  infoMock.mockReturnValue({ data, isLoading: data === undefined });
  return render(<VersionBadge />);
}

describe("VersionBadge", () => {
  it("shows the current version and an 'up to date' status when latest matches", () => {
    setup({
      version: "0.2.0",
      latest: {
        kind: "ok",
        release: {
          tag: "v0.2.0",
          htmlUrl: "https://github.com/JimJafar/the-librarian/releases/tag/v0.2.0",
          publishedAt: "2026-06-01T00:00:00Z",
          bodyExcerpt: null,
        },
        cachedAt: "2026-06-01T00:00:00Z",
      },
    });
    const badge = screen.getByTestId("version-badge");
    expect(badge).toHaveAttribute("data-status", "up_to_date");
    expect(badge.textContent).toContain("v0.2.0");
    expect(badge).toHaveAttribute(
      "href",
      "https://github.com/JimJafar/the-librarian/releases/tag/v0.2.0",
    );
  });

  it("shows 'behind' when the local version is older than the latest release", () => {
    setup({
      version: "0.1.1",
      latest: {
        kind: "ok",
        release: {
          tag: "v0.2.0",
          htmlUrl: "https://example/releases/tag/v0.2.0",
          publishedAt: "2026-06-01T00:00:00Z",
          bodyExcerpt: null,
        },
        cachedAt: "2026-06-01T00:00:00Z",
      },
    });
    const badge = screen.getByTestId("version-badge");
    expect(badge).toHaveAttribute("data-status", "behind");
    expect(badge.getAttribute("title")).toMatch(/v0\.2\.0 available/i);
  });

  it("links to /releases when no release is published yet", () => {
    setup({
      version: "0.1.1",
      latest: { kind: "no_release", cachedAt: "2026-06-01T00:00:00Z" },
    });
    const badge = screen.getByTestId("version-badge");
    expect(badge).toHaveAttribute("data-status", "unknown");
    expect(badge.getAttribute("href")).toMatch(/\/releases$/);
    expect(badge.getAttribute("title")).toMatch(/no published releases yet/i);
  });

  it("renders gracefully when the GitHub lookup is unavailable", () => {
    setup({
      version: "0.1.1",
      latest: { kind: "unavailable", reason: "network_error" },
    });
    const badge = screen.getByTestId("version-badge");
    expect(badge).toHaveAttribute("data-status", "unknown");
    expect(badge.getAttribute("title")).toMatch(/couldn't reach github/i);
  });

  it("renders a loading state until the query returns", () => {
    setup(undefined);
    const badge = screen.getByTestId("version-badge");
    expect(badge).toHaveAttribute("data-status", "loading");
    expect(badge.textContent).toContain("v");
  });
});
