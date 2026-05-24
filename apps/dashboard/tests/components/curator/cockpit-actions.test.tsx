import type { CuratorConfig, CuratorConfigPatch } from "@librarian/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CuratorConfigForm } from "@/components/curator/config-form";
import { RunNowButton } from "@/components/curator/run-now-button";

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
    render(<RunNowButton onRun={onRun} />);
    await userEvent.click(screen.getByRole("button", { name: /run now/i }));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Ran — 2 of 2 due/)).toBeTruthy();
  });

  it("reports a skip reason when nothing ran", async () => {
    const onRun = vi.fn(async () => ({
      ok: true as const,
      result: { ran: false as const, reason: "disabled" as const },
    }));
    render(<RunNowButton onRun={onRun} />);
    await userEvent.click(screen.getByRole("button", { name: /run now/i }));
    expect(screen.getByText(/Skipped — disabled/)).toBeTruthy();
  });

  it("surfaces an error", async () => {
    const onRun = vi.fn(async () => ({ ok: false as const, error: "nope" }));
    render(<RunNowButton onRun={onRun} />);
    await userEvent.click(screen.getByRole("button", { name: /run now/i }));
    expect(screen.getByText(/Error: nope/)).toBeTruthy();
  });
});

const config: CuratorConfig = {
  enabled: false,
  llm: { provider: "openai", endpoint: "https://e/v1", model: "gpt-x" },
  hasToken: true,
  promptAddendum: "",
  defaultAutoApply: "safe_only",
  autoApplyConfidence: 0.9,
  schedule: { intervalDays: 1, time: "03:00" },
  isLlmComplete: true,
  isOperational: false,
};

describe("CuratorConfigForm", () => {
  it("pre-fills from the current config and saves a patch without the token when left blank", async () => {
    const onSave = vi.fn(async (_patch: CuratorConfigPatch) => ({ ok: true as const }));
    render(<CuratorConfigForm initial={config} onSave={onSave} />);

    expect((screen.getByLabelText("Provider") as HTMLInputElement).value).toBe("openai");
    expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("gpt-x");

    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const patch = onSave.mock.calls[0]![0];
    expect(patch).toMatchObject({
      enabled: false,
      llm: { provider: "openai", endpoint: "https://e/v1", model: "gpt-x" },
      defaultAutoApply: "safe_only",
      autoApplyConfidence: 0.9,
      schedule: { intervalDays: 1, time: "03:00" },
    });
    expect("token" in patch).toBe(false); // blank token field → unchanged
    expect(screen.getByText("Saved.")).toBeTruthy();
  });

  it("includes the token only when the field is filled", async () => {
    const onSave = vi.fn(async (_patch: CuratorConfigPatch) => ({ ok: true as const }));
    render(<CuratorConfigForm initial={config} onSave={onSave} />);
    await userEvent.type(screen.getByLabelText(/API token/), "new-token-value");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave.mock.calls[0]![0].token).toBe("new-token-value");
  });
});
