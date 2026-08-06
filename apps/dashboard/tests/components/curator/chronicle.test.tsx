import type { ChronicleConfig, ChronicleRun, ChronicleTickResult } from "@librarian/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChronicleConfigForm } from "@/components/curator/chronicle-config-form";
import { ChronicleRunsTable } from "@/components/curator/chronicle-runs-table";
import { RunNowButton, renderChronicleResult } from "@/components/curator/run-now-button";
import { CuratorTabs } from "@/components/curator/tabs-shell";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const config: ChronicleConfig = {
  enabled: false,
  dayOfWeek: "monday",
  scheduleTime: "08:00",
};

function run(overrides: Partial<ChronicleRun> = {}): ChronicleRun {
  return {
    id: "chr_1",
    status: "completed",
    trigger: "schedule",
    shelf_id: "personal",
    shelf_label: "Personal",
    period_start: "2026-07-27",
    period_end: "2026-08-02",
    iso_week: "2026-W31",
    partial: false,
    narrative: "generated",
    path: "references/chronicle/2026-W31.md",
    duration_ms: 1250,
    model_provider: "provider_1",
    model_name: "narrator-x",
    usage_input_tokens: 120,
    usage_output_tokens: 40,
    error: null,
    created_at: "2026-08-03T08:00:00.000Z",
    started_at: "2026-08-03T08:00:00.000Z",
    completed_at: "2026-08-03T08:00:01.250Z",
    ...overrides,
  };
}

describe("ChronicleConfigForm", () => {
  it("saves enablement, weekday, and local time", async () => {
    const onSave = vi.fn(async () => ({ ok: true as const }));
    render(<ChronicleConfigForm initial={config} onSave={onSave} />);

    await userEvent.click(screen.getByRole("checkbox", { name: /enable scheduled chronicle/i }));
    await userEvent.selectOptions(screen.getByLabelText(/weekday/i), "friday");
    const time = screen.getByLabelText(/time/i);
    await userEvent.clear(time);
    await userEvent.type(time, "17:30");
    await userEvent.click(screen.getByRole("button", { name: /save schedule/i }));

    expect(onSave).toHaveBeenCalledWith({
      enabled: true,
      dayOfWeek: "friday",
      scheduleTime: "17:30",
    });
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
  });

  it("surfaces a save error without losing the entered schedule", async () => {
    const onSave = vi.fn(async () => ({ ok: false as const, error: "schedule unavailable" }));
    render(<ChronicleConfigForm initial={config} onSave={onSave} />);
    await userEvent.selectOptions(screen.getByLabelText(/weekday/i), "sunday");
    await userEvent.click(screen.getByRole("button", { name: /save schedule/i }));
    expect(screen.getByRole("alert")).toHaveTextContent("schedule unavailable");
    expect(screen.getByLabelText(/weekday/i)).toHaveValue("sunday");
  });
});

describe("ChronicleRunsTable", () => {
  it("renders a useful empty state", () => {
    render(<ChronicleRunsTable runs={[]} />);
    expect(screen.getByText(/no chronicle entries yet/i)).toBeInTheDocument();
  });

  it("shows period, shelf, narrative mode, model usage, and entry path", () => {
    render(<ChronicleRunsTable runs={[run()]} />);
    expect(screen.getByText("2026-W31")).toBeInTheDocument();
    expect(screen.getByText("Personal")).toBeInTheDocument();
    expect(screen.getByText("Narrated")).toBeInTheDocument();
    expect(screen.getByText("120/40")).toBeInTheDocument();
    expect(screen.getByText("1.3s")).toBeInTheDocument();
    expect(screen.getByText("narrator-x")).toBeInTheDocument();
    expect(screen.getByText("references/chronicle/2026-W31.md")).toBeInTheDocument();
  });

  it("labels digest-only and failed runs plainly", () => {
    render(
      <ChronicleRunsTable
        runs={[
          run({ id: "digest", narrative: "skipped", model_name: null }),
          run({ id: "failed", status: "failed", error: "write_failed", path: null }),
        ]}
      />,
    );
    expect(screen.getByText("Digest only")).toBeInTheDocument();
    expect(screen.getByText("write failed")).toBeInTheDocument();
  });
});

describe("Chronicle run now", () => {
  it("reports per-shelf generated and digest counts", async () => {
    const result: ChronicleTickResult = {
      ran: true,
      trigger: "manual",
      period: {
        start: "2026-08-03",
        end: "2026-08-06",
        isoWeek: "2026-W32",
        partial: true,
      },
      attempted: 2,
      completed: 2,
      failed: 0,
      generated: 1,
      digestOnly: 1,
    };
    render(
      <RunNowButton
        onRun={async () => ({ ok: true, result })}
        renderResult={renderChronicleResult}
        label="Run Chronicle now"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /run chronicle now/i }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "2 of 2 shelves written — 1 narrated, 1 digest only",
    );
  });
});

describe("CuratorTabs", () => {
  it("offers Chronicle as the third keyboard-accessible job tab", () => {
    render(
      <CuratorTabs
        intake={<p>Intake panel</p>}
        grooming={<p>Grooming panel</p>}
        chronicle={<p>Chronicle panel</p>}
      />,
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Intake", "Grooming", "Chronicle"]);
  });
});
