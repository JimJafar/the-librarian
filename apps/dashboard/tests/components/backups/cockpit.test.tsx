import type { BackupRun } from "@librarian/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { BackupConfigSummary } = await import("@/components/backups/config-summary");
const { BackupConfigForm } = await import("@/components/backups/config-form");
const { BackupRunsTable } = await import("@/components/backups/runs-table");
const { RestoreButton } = await import("@/components/backups/restore-button");
const { RestartPrompt } = await import("@/components/backups/restart-prompt");

type Config = Parameters<typeof BackupConfigSummary>[0]["config"];

function cfg(over: Partial<Config> = {}): Config {
  return {
    enabled: false,
    intervalMinutes: 1440,
    webhookUrl: "",
    github: { repo: "", hasToken: false },
    ...over,
  };
}

function run(over: Partial<BackupRun> = {}): BackupRun {
  return {
    id: "bkp_1",
    status: "ok",
    trigger: "manual",
    target: "me/bk",
    bundle: "abc1234def",
    bytes: 0,
    synced: true,
    error: null,
    created_at: "2026-05-30T00:00:00.000Z",
    started_at: "2026-05-30T00:00:00.000Z",
    completed_at: "2026-05-30T00:00:01.000Z",
    ...over,
  };
}

describe("BackupConfigSummary", () => {
  it("shows the schedule state and the GitHub remote", () => {
    render(
      <BackupConfigSummary
        config={cfg({ enabled: true, github: { repo: "me/bk", hasToken: true } })}
      />,
    );
    expect(screen.getByText("Schedule enabled")).toBeTruthy();
    expect(screen.getByText(/GitHub → me\/bk/)).toBeTruthy();
  });
});

describe("BackupConfigForm", () => {
  it("shows the GitHub remote fields and keeps the token write-only", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true });
    render(
      <BackupConfigForm
        initial={cfg({ github: { repo: "me/bk", hasToken: true } })}
        onSave={onSave}
      />,
    );

    expect(screen.getByPlaceholderText("me/librarian-vault-backup")).toBeTruthy();
    fireEvent.submit(screen.getByLabelText("Backup configuration form"));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const input = onSave.mock.calls[0]![0];
    expect(input.github.repo).toBe("me/bk");
    expect(input.github.token).toBeUndefined(); // blank token not round-tripped
  });

  it("sends a newly typed token but not the placeholder", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true });
    render(
      <BackupConfigForm
        initial={cfg({ github: { repo: "me/bk", hasToken: true } })}
        onSave={onSave}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Fine-grained token/), {
      target: { value: "ghp_secret" },
    });
    fireEvent.submit(screen.getByLabelText("Backup configuration form"));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0].github.token).toBe("ghp_secret");
  });
});

describe("BackupRunsTable", () => {
  it("renders runs and an empty state", () => {
    const { rerender } = render(<BackupRunsTable runs={[]} />);
    expect(screen.getByText("No backup runs yet.")).toBeTruthy();
    rerender(<BackupRunsTable runs={[run({ status: "error", error: "boom" })]} />);
    expect(screen.getByText("error")).toBeTruthy();
    expect(screen.getByText("boom")).toBeTruthy();
  });
});

describe("RestoreButton → RestartPrompt", () => {
  it("confirms, stages, then reveals the warned restart prompt", async () => {
    const onStage = vi.fn().mockResolvedValue({ ok: true, staged: "me/bk" });
    const onRestart = vi.fn().mockResolvedValue({ ok: true });
    render(<RestoreButton onStage={onStage} onRestart={onRestart} />);

    fireEvent.click(screen.getByRole("button", { name: /Restore from backup/ }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm restore" }));

    await waitFor(() => expect(screen.getByText(/Restart required to apply/)).toBeTruthy());
    expect(onStage).toHaveBeenCalledTimes(1);
    // The load-bearing warning is present.
    expect(screen.getByText(/not come back/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Restart now" }));
    await waitFor(() => expect(onRestart).toHaveBeenCalledTimes(1));
  });
});

describe("RestartPrompt", () => {
  it("surfaces a restart error", async () => {
    const onRestart = vi.fn().mockResolvedValue({ ok: false, error: "nope" });
    render(<RestartPrompt onRestart={onRestart} />);
    fireEvent.click(screen.getByRole("button", { name: "Restart now" }));
    await waitFor(() => expect(screen.getByText(/Error: nope/)).toBeTruthy());
  });
});
