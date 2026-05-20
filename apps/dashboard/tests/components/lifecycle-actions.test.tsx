import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionRow } from "@/components/sessions/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/app/sessions/[id]/actions", () => ({
  checkpointSessionAction: vi.fn(),
  pauseSessionAction: vi.fn(),
  endSessionAction: vi.fn(),
  archiveSessionAction: vi.fn(),
  restoreSessionAction: vi.fn(),
  deleteSessionAction: vi.fn(),
}));

const { LifecycleActions } = await import("@/components/sessions/lifecycle-actions");

function makeSession(status: SessionRow["status"]): SessionRow {
  // SessionRow's tRPC-inferred type narrows several nullable fields oddly
  // through `inferRouterOutputs`; cast via `unknown` to keep the test
  // fixture readable. `LifecycleActions` only reads `id`, `title`, `status`.
  return {
    id: "ses_test",
    title: "Test",
    status,
    project_key: null,
    prior_status: null,
    visibility: "common",
    created_by_agent_id: null,
    current_agent_id: null,
    created_in_harness: null,
    current_harness: null,
    source_ref: null,
    cwd: null,
    start_summary: null,
    rolling_summary: null,
    end_summary: null,
    next_steps: [],
    tags: [],
    capture_mode: "summary",
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_activity_at: new Date().toISOString(),
    paused_at: null,
    ended_at: null,
    archived_at: null,
    deleted_at: null,
    metadata: {},
  } as unknown as SessionRow;
}

describe("LifecycleActions button gating", () => {
  it("shows Checkpoint / Pause / End / Archive / Delete for active sessions", () => {
    render(<LifecycleActions session={makeSession("active")} />);
    expect(screen.getByRole("button", { name: "Checkpoint" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "End" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
  });

  it("also shows Checkpoint / Pause / End for paused sessions (T6.6 review fix)", () => {
    render(<LifecycleActions session={makeSession("paused")} />);
    expect(screen.getByRole("button", { name: "Checkpoint" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "End" })).toBeInTheDocument();
  });

  it("shows Restore (not Archive) for archived sessions, plus Delete", () => {
    render(<LifecycleActions session={makeSession("archived")} />);
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("hides Delete for already-deleted sessions (T6.6 review fix)", () => {
    render(<LifecycleActions session={makeSession("deleted")} />);
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
  });

  it("hides lifecycle buttons (checkpoint/pause/end) when the session is ended", () => {
    render(<LifecycleActions session={makeSession("ended")} />);
    expect(screen.queryByRole("button", { name: "Checkpoint" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "End" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
  });
});
