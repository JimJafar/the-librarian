import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { BackupNowButton } = await import("@/components/backups/backup-now-button");

describe("BackupNowButton", () => {
  it("reports success after a backup", async () => {
    const onRun = vi.fn().mockResolvedValue({ ok: true, dir: "/d", files: 4, synced: false });
    render(<BackupNowButton onRun={onRun} />);
    fireEvent.click(screen.getByRole("button", { name: "Backup now" }));
    await waitFor(() => expect(screen.getByText(/Backed up 4 file/)).toBeInTheDocument());
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it("reports the cloud-sync state when synced", async () => {
    const onRun = vi.fn().mockResolvedValue({ ok: true, dir: "/d", files: 4, synced: true });
    render(<BackupNowButton onRun={onRun} />);
    fireEvent.click(screen.getByRole("button", { name: "Backup now" }));
    await waitFor(() => expect(screen.getByText(/synced to cloud/)).toBeInTheDocument());
  });

  it("surfaces an error", async () => {
    const onRun = vi.fn().mockResolvedValue({ ok: false, error: "boom" });
    render(<BackupNowButton onRun={onRun} />);
    fireEvent.click(screen.getByRole("button", { name: "Backup now" }));
    await waitFor(() => expect(screen.getByText(/Error: boom/)).toBeInTheDocument());
  });
});
