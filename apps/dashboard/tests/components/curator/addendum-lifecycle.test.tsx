import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AddendumLifecycle } from "@/components/curator/addendum-lifecycle";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const okAddendum = vi.fn(async () => ({
  ok: true as const,
  addendum: { content: "x", version: "v", status: "accepted" as const, evalVersion: null },
}));
const okReEvaluate = vi.fn(async () => ({
  ok: true as const,
  result: { reEvaluated: true as const, count: 2 },
}));
const okDryRun = vi.fn(async () => ({ ok: true as const, result: { started: true as const } }));

function renderLifecycle(over: Partial<Parameters<typeof AddendumLifecycle>[0]> = {}) {
  render(
    <AddendumLifecycle
      job="grooming"
      status="accepted"
      evalVersion={null}
      enabled
      candidate=""
      onAccept={okAddendum}
      onRollback={okAddendum}
      onReEvaluate={okReEvaluate}
      onDryRun={okDryRun}
      {...over}
    />,
  );
}

describe("AddendumLifecycle", () => {
  it("shows the accepted status + version", () => {
    renderLifecycle({ status: "accepted", evalVersion: null });
    expect(screen.getAllByText(/accepted/i).length).toBeGreaterThan(0);
  });

  it("shows the under-evaluation status with the version when evaluating", () => {
    renderLifecycle({ status: "under_evaluation", evalVersion: "abcdef0" });
    expect(screen.getByText(/under evaluation/i)).toBeTruthy();
    expect(screen.getByText(/abcdef0/)).toBeTruthy();
  });

  it("drives Accept (D3)", async () => {
    renderLifecycle({ status: "under_evaluation", evalVersion: "v1" });
    await userEvent.click(screen.getByRole("button", { name: /accept/i }));
    await waitFor(() => expect(okAddendum).toHaveBeenCalledWith({ job: "grooming" }));
  });

  it("drives Roll-back (D3)", async () => {
    const onRollback = vi.fn(async () => ({
      ok: true as const,
      addendum: { content: "x", version: "v", status: "accepted" as const, evalVersion: null },
    }));
    renderLifecycle({ status: "under_evaluation", evalVersion: "v1", onRollback });
    await userEvent.click(screen.getByRole("button", { name: /roll.?back/i }));
    await waitFor(() => expect(onRollback).toHaveBeenCalledWith({ job: "grooming" }));
  });

  it("drives Re-evaluate (D3c, grooming) with the count surfaced", async () => {
    const onReEvaluate = vi.fn(async () => ({
      ok: true as const,
      result: { reEvaluated: true as const, count: 3 },
    }));
    renderLifecycle({ status: "under_evaluation", evalVersion: "v1", onReEvaluate });
    await userEvent.click(screen.getByRole("button", { name: /re-?evaluate/i }));
    await waitFor(() => expect(onReEvaluate).toHaveBeenCalledWith({ job: "grooming" }));
    await waitFor(() => expect(screen.getByText(/3/)).toBeTruthy());
  });

  it("drives Dry-run (D4) with the current candidate addendum", async () => {
    const onDryRun = vi.fn(async () => ({ ok: true as const, result: { started: true as const } }));
    renderLifecycle({ candidate: "draft guidance", onDryRun });
    await userEvent.click(screen.getByRole("button", { name: /dry.?run/i }));
    await waitFor(() =>
      expect(onDryRun).toHaveBeenCalledWith({ candidateAddendum: "draft guidance" }),
    );
  });

  it("does NOT render Dry-run or Re-evaluate for intake (grooming-only)", () => {
    renderLifecycle({ job: "intake", status: "under_evaluation", evalVersion: "v1" });
    expect(screen.queryByRole("button", { name: /dry.?run/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /re-?evaluate/i })).toBeNull();
    // Accept + Roll-back still exist for intake.
    expect(screen.getByRole("button", { name: /accept/i })).toBeTruthy();
  });

  it("makes the probation/dry-run controls INERT with a clear message when the job is disabled (D-11)", async () => {
    renderLifecycle({ enabled: false, candidate: "draft", status: "under_evaluation" });
    expect(screen.getByText(/disabled/i)).toBeTruthy();
    // Dry-run / re-evaluate are inert (disabled) when the job is off.
    const dryRun = screen.getByRole("button", { name: /dry.?run/i });
    expect(dryRun).toBeDisabled();
    const reEval = screen.getByRole("button", { name: /re-?evaluate/i });
    expect(reEval).toBeDisabled();
  });
});
