// Per-file history panel (rethink T20, spec §8 / D16): commit list newest
// first, "what this version changed" diff (against the previous version in
// the file's history), +/- line colouring without a diff dependency, and
// "Restore this version" behind a confirm dialog — surfacing the server's
// teaching refusal when an old version no longer validates.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VaultFileCommit } from "@/app/vault/actions";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock, push: vi.fn() }),
}));

const { FileHistory, DiffView } = await import("@/components/vault/file-history");

const commits: VaultFileCommit[] = [
  {
    hash: "b".repeat(40),
    date: "2026-06-12T10:00:00+00:00",
    author: "The Librarian",
    subject: "vault: edit references/doc.md",
    path: "references/doc.md",
  },
  {
    hash: "a".repeat(40),
    date: "2026-06-11T09:00:00+00:00",
    author: "The Librarian",
    subject: "vault: create references/doc.md",
    path: "references/doc.md",
  },
];

const actions = () => ({
  history: vi.fn().mockResolvedValue({ ok: true, commits }),
  diff: vi.fn().mockResolvedValue({ ok: true, diff: "-# Doc v1\n+# Doc v2" }),
  restoreVersion: vi.fn().mockResolvedValue({ ok: true }),
});

afterEach(() => vi.clearAllMocks());

describe("FileHistory", () => {
  it("lists the file's commits newest-first with subject + short hash", async () => {
    render(<FileHistory path="references/doc.md" actions={actions()} />);
    const list = await screen.findByRole("list", { name: "File history" });
    expect(list).toHaveTextContent("vault: edit references/doc.md");
    expect(list).toHaveTextContent("bbbbbbbbbbbb");
    expect(list).toHaveTextContent("vault: create references/doc.md");
  });

  it("selecting a commit loads its diff against the previous version", async () => {
    const acts = actions();
    render(<FileHistory path="references/doc.md" actions={acts} />);
    await userEvent.click(await screen.findByText("vault: edit references/doc.md"));
    await vi.waitFor(() =>
      expect(acts.diff).toHaveBeenCalledWith({
        path: "references/doc.md",
        from: "a".repeat(40),
        to: "b".repeat(40),
      }),
    );
    expect(await screen.findByLabelText("Unified diff")).toHaveTextContent("+# Doc v2");
  });

  it("expands a commit inline and collapses it on a second click (accordion)", async () => {
    render(<FileHistory path="references/doc.md" actions={actions()} />);
    const row = await screen.findByRole("button", { name: /vault: edit references\/doc\.md/ });
    expect(row).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByLabelText("Unified diff")).toBeInTheDocument();

    await userEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "false");
    await vi.waitFor(() => expect(screen.queryByLabelText("Unified diff")).not.toBeInTheDocument());
  });

  it("the oldest commit diffs from the file's birth (no `from`)", async () => {
    const acts = actions();
    render(<FileHistory path="references/doc.md" actions={acts} />);
    await userEvent.click(await screen.findByText("vault: create references/doc.md"));
    await vi.waitFor(() =>
      expect(acts.diff).toHaveBeenCalledWith({ path: "references/doc.md", to: "a".repeat(40) }),
    );
  });

  it("restore asks for confirmation before calling the action, then refreshes", async () => {
    const acts = actions();
    render(<FileHistory path="references/doc.md" actions={acts} />);
    await userEvent.click(await screen.findByText("vault: edit references/doc.md"));
    await userEvent.click(await screen.findByRole("button", { name: "Restore this version" }));
    expect(acts.restoreVersion).not.toHaveBeenCalled(); // dialog first, never direct
    await userEvent.click(await screen.findByRole("button", { name: "Restore version" }));
    await vi.waitFor(() =>
      expect(acts.restoreVersion).toHaveBeenCalledWith({
        path: "references/doc.md",
        hash: "b".repeat(40),
      }),
    );
    await vi.waitFor(() => expect(refreshMock).toHaveBeenCalled());
  });

  it("surfaces the server's teaching refusal inline (validation-failing restore)", async () => {
    const acts = actions();
    acts.restoreVersion.mockResolvedValue({
      ok: false,
      error:
        "'memories/legacy.md' was not restored: that version no longer passes memory validation. " +
        "Open the file in the editor and bring the old content forward manually instead.",
    });
    render(<FileHistory path="memories/legacy.md" actions={acts} />);
    await userEvent.click(await screen.findByText("vault: edit references/doc.md"));
    await userEvent.click(await screen.findByRole("button", { name: "Restore this version" }));
    await userEvent.click(await screen.findByRole("button", { name: "Restore version" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/bring the old content forward/);
  });
});

describe("DiffView", () => {
  it("colours additions and deletions per line", () => {
    render(<DiffView diff={"@@ -1 +1 @@\n-old line\n+new line\n context"} />);
    const pre = screen.getByLabelText("Unified diff");
    expect(pre).toHaveTextContent("-old line");
    expect(pre).toHaveTextContent("+new line");
    const lines = Array.from(pre.querySelectorAll("span"));
    // Editorial palette: verdigris wash for additions, destructive (red-ochre)
    // for deletions (rc.19 — swapped from emerald/red Tailwind defaults).
    expect(lines.find((l) => l.textContent === "+new line")?.className).toMatch(/ink-accent/);
    expect(lines.find((l) => l.textContent === "-old line")?.className).toMatch(/destructive/);
  });

  it("says so when the versions are identical", () => {
    render(<DiffView diff="" />);
    expect(screen.getByText(/identical/)).toBeInTheDocument();
  });
});
