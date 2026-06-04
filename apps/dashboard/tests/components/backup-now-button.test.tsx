import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { BackupNowButton } = await import("@/components/backups/backup-now-button");

describe("BackupNowButton", () => {
  it("reports the pushed repo + commit after a backup", async () => {
    const onRun = vi.fn().mockResolvedValue({ ok: true, commit: "abc1234def", repo: "me/bk" });
    render(<BackupNowButton onRun={onRun} />);
    fireEvent.click(screen.getByRole("button", { name: "Backup now" }));
    await waitFor(() => expect(screen.getByText(/Pushed to me\/bk/)).toBeInTheDocument());
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it("surfaces an error", async () => {
    const onRun = vi.fn().mockResolvedValue({ ok: false, error: "boom" });
    render(<BackupNowButton onRun={onRun} />);
    fireEvent.click(screen.getByRole("button", { name: "Backup now" }));
    await waitFor(() => expect(screen.getByText(/Error: boom/)).toBeInTheDocument());
  });
});
