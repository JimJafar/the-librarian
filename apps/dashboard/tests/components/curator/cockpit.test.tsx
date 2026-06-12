import type { GroomingConfig, CurationRun } from "@librarian/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GroomingConfigSummary } from "@/components/curator/config-summary";
import { GroomingRunsTable } from "@/components/curator/runs-table";

function config(over: Partial<GroomingConfig> = {}): GroomingConfig {
  return {
    enabled: false,
    defaultAutoApply: "safe_only",
    autoApplyConfidence: 0.9,
    intervalDays: 1,
    scheduleTime: "03:00",
    triggerThreshold: 20,
    debounceMinutes: 60,
    maxMemoriesPerRun: 200,
    ...over,
  };
}

function run(over: Partial<CurationRun> = {}): CurationRun {
  return {
    id: "run_1",
    status: "completed",
    trigger: "schedule",
    mode: "apply",
    project_key: "proj-x",
    input_hash: "h",
    input_memory_ids: [],
    model_provider: "openai",
    model_name: "gpt-x",
    usage_input_tokens: 10,
    usage_output_tokens: 5,
    summary: "applied 2, skipped 1",
    error: null,
    created_at: "2026-05-24T00:00:00.000Z",
    started_at: "2026-05-24T00:00:00.000Z",
    completed_at: "2026-05-24T00:01:00.000Z",
    ...over,
  };
}

describe("GroomingConfigSummary", () => {
  it("shows Disabled by default", () => {
    render(<GroomingConfigSummary config={config()} />);
    expect(screen.getByText("Disabled")).toBeTruthy();
  });

  it("shows Enabled when scheduled curation is on", () => {
    render(<GroomingConfigSummary config={config({ enabled: true })} />);
    expect(screen.getByText("Enabled")).toBeTruthy();
  });
});

describe("GroomingRunsTable", () => {
  it("renders an empty state with no runs", () => {
    render(<GroomingRunsTable runs={[]} />);
    expect(screen.getByText(/no curation runs/i)).toBeTruthy();
  });

  it("renders a run row with its summary, tokens, and model", () => {
    render(<GroomingRunsTable runs={[run()]} />);
    expect(screen.getByText("applied 2, skipped 1")).toBeTruthy();
    expect(screen.getByText("10/5")).toBeTruthy();
    expect(screen.getByText("gpt-x")).toBeTruthy();
  });
});
