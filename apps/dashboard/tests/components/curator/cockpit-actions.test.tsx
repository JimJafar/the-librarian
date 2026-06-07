import type { CuratorConfig, CuratorConfigPatch } from "@librarian/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CuratorConfigForm } from "@/components/curator/config-form";
import {
  RunNowButton,
  renderGroomingResult,
  renderIntakeResult,
} from "@/components/curator/run-now-button";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const summary = {
  due: 2,
  ran: 2,
  skippedLocked: 0,
  skippedIdempotent: 0,
  reclaimedStaleLocks: 0,
  errored: 0,
};

describe("RunNowButton", () => {
  it("reports the run summary on success", async () => {
    const onRun = vi.fn(async () => ({
      ok: true as const,
      result: { ran: true as const, summary },
    }));
    render(<RunNowButton onRun={onRun} renderResult={renderGroomingResult} />);
    await userEvent.click(screen.getByRole("button", { name: /run now/i }));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Ran — 2 of 2 due/)).toBeTruthy();
  });

  it("reports a skip reason when nothing ran", async () => {
    const onRun = vi.fn(async () => ({
      ok: true as const,
      result: { ran: false as const, reason: "disabled" as const },
    }));
    render(<RunNowButton onRun={onRun} renderResult={renderGroomingResult} />);
    await userEvent.click(screen.getByRole("button", { name: /run now/i }));
    expect(screen.getByText(/Skipped — disabled/)).toBeTruthy();
  });

  it("surfaces an error", async () => {
    const onRun = vi.fn(async () => ({ ok: false as const, error: "nope" }));
    render(<RunNowButton onRun={onRun} renderResult={renderGroomingResult} />);
    await userEvent.click(screen.getByRole("button", { name: /run now/i }));
    expect(screen.getByText(/Error: nope/)).toBeTruthy();
  });

  it("renders an intake sweep result with a custom label and renderer", async () => {
    const onRun = vi.fn(async () => ({
      ok: true as const,
      result: {
        ran: true as const,
        summary: {
          reclaimed: 0,
          consolidated: 3,
          judgeErrors: 0,
          claimedByOther: 0,
          errored: 0,
        },
      },
    }));
    render(<RunNowButton onRun={onRun} renderResult={renderIntakeResult} label="Run intake now" />);
    await userEvent.click(screen.getByRole("button", { name: /run intake now/i }));
    expect(screen.getByText(/Ran — 3 item\(s\) consolidated/)).toBeTruthy();
  });

  it("surfaces an intake disabled skip (not swallowed)", async () => {
    const onRun = vi.fn(async () => ({
      ok: true as const,
      result: { ran: false as const, reason: "disabled" as const },
    }));
    render(<RunNowButton onRun={onRun} renderResult={renderIntakeResult} label="Run intake now" />);
    await userEvent.click(screen.getByRole("button", { name: /run intake now/i }));
    expect(screen.getByText(/Skipped — disabled/)).toBeTruthy();
  });
});

const config: CuratorConfig = {
  enabled: false,
  defaultAutoApply: "safe_only",
  autoApplyConfidence: 0.9,
  intervalMinutes: 60,
  triggerThreshold: 20,
  debounceMinutes: 60,
  maxMemoriesPerRun: 200,
};

describe("CuratorConfigForm", () => {
  it("pre-fills from the current NON-LLM config and saves a patch (no LLM fields)", async () => {
    const onSave = vi.fn(async (_patch: CuratorConfigPatch) => ({ ok: true as const }));
    render(<CuratorConfigForm initial={config} onSave={onSave} />);

    expect((screen.getByLabelText("Run every N minutes") as HTMLInputElement).value).toBe("60");
    expect((screen.getByLabelText("Confidence (0–1)") as HTMLInputElement).value).toBe("0.9");

    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const patch = onSave.mock.calls[0]![0];
    expect(patch).toMatchObject({
      enabled: false,
      defaultAutoApply: "safe_only",
      autoApplyConfidence: 0.9,
      intervalMinutes: 60,
    });
    // The LLM connection moved out of this form (provider manager + per-consumer
    // selectors own it now) — the patch must carry no LLM/token keys.
    expect("llm" in patch).toBe(false);
    expect("token" in patch).toBe(false);
    // The prompt addendum left this form too (spec 044 D-1 — it's a committed
    // vault file now; its dashboard editor is D7), so the patch must not set it.
    expect("promptAddendum" in patch).toBe(false);
    expect(screen.getByText("Saved.")).toBeTruthy();
  });
});
