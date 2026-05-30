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
    target: "local",
    retentionKeep: 14,
    webhookUrl: "",
    s3: {
      bucket: "",
      region: "",
      endpoint: "",
      prefix: "",
      hasAccessKey: false,
      hasSecretKey: false,
    },
    github: { repo: "", hasToken: false },
    ...over,
  };
}

function run(over: Partial<BackupRun> = {}): BackupRun {
  return {
    id: "bkp_1",
    status: "ok",
    trigger: "manual",
    target: "local",
    bundle: "librarian-backup-x",
    bytes: 1234,
    synced: false,
    error: null,
    created_at: "2026-05-30T00:00:00.000Z",
    started_at: "2026-05-30T00:00:00.000Z",
    completed_at: "2026-05-30T00:00:01.000Z",
    ...over,
  };
}

describe("BackupConfigSummary", () => {
  it("shows the schedule state, target, retention and webhook", () => {
    render(
      <BackupConfigSummary
        config={cfg({ enabled: true, target: "github", github: { repo: "me/bk", hasToken: true } })}
      />,
    );
    expect(screen.getByText("Schedule enabled")).toBeTruthy();
    expect(screen.getByText(/GitHub → me\/bk/)).toBeTruthy();
    expect(screen.getByText(/keep 14 bundle/)).toBeTruthy();
  });
});

describe("BackupConfigForm", () => {
  it("shows GitHub fields for the github target and keeps the token write-only", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true });
    render(
      <BackupConfigForm
        initial={cfg({ target: "github", github: { repo: "me/bk", hasToken: true } })}
        onSave={onSave}
      />,
    );

    expect(screen.getByPlaceholderText("me/librarian-backups")).toBeTruthy();
    fireEvent.submit(screen.getByLabelText("Backup configuration form"));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const input = onSave.mock.calls[0][0];
    expect(input.target).toBe("github");
    expect(input.github.repo).toBe("me/bk");
    expect(input.github.token).toBeUndefined(); // blank token not round-tripped
    expect(input.s3.accessKey).toBeUndefined();
  });

  it("sends a newly typed secret but not the placeholder", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true });
    render(<BackupConfigForm initial={cfg({ target: "s3" })} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("Access key (blank = keep)"), {
      target: { value: "AKIA123" },
    });
    fireEvent.submit(screen.getByLabelText("Backup configuration form"));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].s3.accessKey).toBe("AKIA123");
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
  it("two-step restore then reveals the warned restart prompt", async () => {
    const onStage = vi.fn().mockResolvedValue({ ok: true, staged: "librarian-backup-x" });
    const onRestart = vi.fn().mockResolvedValue({ ok: true });
    render(<RestoreButton bundle="librarian-backup-x" onStage={onStage} onRestart={onRestart} />);

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm restore" }));

    await waitFor(() => expect(screen.getByText(/Restart required to apply/)).toBeTruthy());
    expect(onStage).toHaveBeenCalledWith("librarian-backup-x");
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
