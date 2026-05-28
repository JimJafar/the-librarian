// Dashboard handoff component tests (sessions-rethink §6.7).
//
// The dashboard surface is read-only — no claim button (claim is an MCP-only
// agent operation). We mock the tRPC client so the tests stay pure.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const listMock = vi.fn();
const byIdMock = vi.fn();

vi.mock("@/lib/trpc-client", () => ({
  trpc: {
    handoffs: {
      list: { useQuery: (...args: unknown[]) => listMock(...args) },
      byId: { useQuery: (...args: unknown[]) => byIdMock(...args) },
    },
  },
}));

const { HandoffsListView } = await import("@/components/handoffs/list-view");
const { HandoffDetailView } = await import("@/components/handoffs/detail-view");

const sampleHandoff = {
  handoff_id: "hdo_abc",
  title: "Continue the migration",
  project_key: "proj-x",
  source_ref: null,
  cwd: "/repo",
  domain: "general",
  created_by_agent_id: "agent-a",
  created_in_harness: "claude-code",
  tags: ["migration"],
  created_at: "2026-05-28T12:00:00.000Z",
  claimed_at: null,
  claimed_by: null,
};

describe("HandoffsListView", () => {
  it("renders empty-state when no rows arrive", () => {
    listMock.mockReturnValue({ data: [], isLoading: false });
    render(<HandoffsListView />);
    expect(screen.getByText(/no handoffs/i)).toBeInTheDocument();
  });

  it("renders one row per handoff with a link to the detail view", () => {
    listMock.mockReturnValue({
      data: [sampleHandoff, { ...sampleHandoff, handoff_id: "hdo_xyz", title: "Another" }],
      isLoading: false,
    });
    render(<HandoffsListView />);
    expect(screen.getByText("Continue the migration").closest("a")).toHaveAttribute(
      "href",
      "/handoffs/hdo_abc",
    );
    expect(screen.getByText("Another").closest("a")).toHaveAttribute("href", "/handoffs/hdo_xyz");
  });
});

describe("HandoffDetailView", () => {
  it("renders the document markdown and metadata sidebar", () => {
    byIdMock.mockReturnValue({
      data: {
        ...sampleHandoff,
        document_md: "# Handoff: test\n\n## Start & intent\nstart here.",
      },
      isLoading: false,
    });
    render(<HandoffDetailView handoffId="hdo_abc" />);
    expect(screen.getByText(/Continue the migration/)).toBeInTheDocument();
    expect(screen.getByText(/Start & intent/)).toBeInTheDocument();
    expect(screen.getByText("hdo_abc")).toBeInTheDocument();
    expect(screen.getByText("unclaimed")).toBeInTheDocument();
  });

  it("renders not-found when the query has no data", () => {
    byIdMock.mockReturnValue({ data: undefined, isLoading: false });
    render(<HandoffDetailView handoffId="hdo_ghost" />);
    expect(screen.getByText(/handoff not found/i)).toBeInTheDocument();
  });
});
