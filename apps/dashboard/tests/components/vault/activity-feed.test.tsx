// Vault activity feed (rethink T21, spec §8 / D16): the audit-trail list
// (subject + provenance badge + files touched) and the guarded whole-vault
// restore — the modal demands the typed RESTORE phrase before the button
// arms, and the success state surfaces the pre-restore safety tag.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VaultActivityEntry } from "@/components/vault/types";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock, push: vi.fn() }),
}));

const { ActivityFeed } = await import("@/components/vault/activity-feed");

const entries: VaultActivityEntry[] = [
  {
    hash: "b".repeat(40),
    date: "2026-06-12T10:00:00+00:00",
    author: "The Librarian",
    subject: "memory: update mem_1",
    files: ["memories/anna-1.md"],
    source: "curator",
  },
  {
    hash: "a".repeat(40),
    date: "2026-06-11T09:00:00+00:00",
    author: "The Librarian",
    subject: "vault: edit references/doc.md",
    files: ["references/doc.md"],
    source: "admin",
  },
];

afterEach(() => vi.clearAllMocks());

describe("ActivityFeed", () => {
  it("lists commits with subject, provenance badge, files, and short hash", () => {
    render(<ActivityFeed entries={entries} onRestore={vi.fn()} />);
    const feed = screen.getByRole("list", { name: "Vault activity" });
    expect(feed).toHaveTextContent("memory: update mem_1");
    expect(feed).toHaveTextContent("curator");
    expect(feed).toHaveTextContent("admin");
    expect(feed).toHaveTextContent("memories/anna-1.md");
    expect(feed).toHaveTextContent("bbbbbbbbbbbb");
  });

  it("keeps the restore button disarmed until the exact phrase is typed", async () => {
    const onRestore = vi.fn().mockResolvedValue({
      ok: true,
      restoredTo: "a".repeat(40),
      preRestoreTag: "pre-restore-20260612-100000",
      commit: "c".repeat(40),
    });
    render(<ActivityFeed entries={entries} onRestore={onRestore} />);
    await userEvent.click(screen.getAllByRole("button", { name: "Restore vault to here" })[1]!);

    const submit = await screen.findByRole("button", { name: "Restore vault" });
    expect(submit).toBeDisabled(); // nothing typed yet
    const input = screen.getByLabelText("Restore confirmation");
    await userEvent.type(input, "restore"); // wrong case — still disarmed
    expect(submit).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, "RESTORE");
    expect(submit).toBeEnabled();

    await userEvent.click(submit);
    await vi.waitFor(() =>
      expect(onRestore).toHaveBeenCalledWith({ hash: "a".repeat(40), confirm: "RESTORE" }),
    );
    // Success state names the pre-restore safety tag.
    expect(await screen.findByText(/pre-restore-20260612-100000/)).toBeInTheDocument();
    await vi.waitFor(() => expect(refreshMock).toHaveBeenCalled());
  });

  it("surfaces the server's refusal inline (e.g. curator run in flight)", async () => {
    const onRestore = vi.fn().mockResolvedValue({
      ok: false,
      error: "a curator run is in flight — wait for it to finish, then retry the restore",
    });
    render(<ActivityFeed entries={entries} onRestore={onRestore} />);
    await userEvent.click(screen.getAllByRole("button", { name: "Restore vault to here" })[0]!);
    await userEvent.type(screen.getByLabelText("Restore confirmation"), "RESTORE");
    await userEvent.click(screen.getByRole("button", { name: "Restore vault" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/curator run is in flight/);
  });
});
