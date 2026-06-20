import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProposalReviewRow } from "@/components/memories/types";

// The proposal card is a client view: it renders one enriched row from
// memories.proposalsForReview and adjudicates it through the approve/reject
// server actions. Both are mocked so this stays a fast component-only check —
// no QueryClient/TRPC provider, no real server. DiffView is the real component
// (it just classifies a unified-diff string), so a rendered diff proves the
// single-target layout wired it.

const approveProposalAction = vi.fn().mockResolvedValue({ ok: true });
const rejectProposalAction = vi.fn().mockResolvedValue({ ok: true });
const archiveMemoryAction = vi.fn().mockResolvedValue({ ok: true });
const refresh = vi.fn();

vi.mock("@/app/(memories)/actions", () => ({
  approveProposalAction: (id: string) => approveProposalAction(id),
  rejectProposalAction: (id: string) => rejectProposalAction(id),
  archiveMemoryAction: (id: string) => archiveMemoryAction(id),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

const { ProposalCard } = await import("@/components/memories/proposal-card");

// Build a MemoryShape-ish row body — only the fields the card reads.
function memory(over: Partial<ProposalReviewRow["proposal"]> = {}): ProposalReviewRow["proposal"] {
  return {
    id: "mem_proposed",
    agent_id: "scribe",
    status: "proposed",
    tags: [],
    applies_to: [],
    supersedes: [],
    conflicts_with: [],
    flags: [],
    title: "Coffee",
    body: "Espresso, one sugar.",
    confidence: "high",
    updated_at: "2026-06-01T00:00:00.000Z",
    curator_note: null,
    is_global: false,
    requires_approval: true,
    ...over,
  } as ProposalReviewRow["proposal"];
}

function row(over: Partial<ProposalReviewRow> = {}): ProposalReviewRow {
  return {
    proposal: memory(),
    action: null,
    source: null,
    rationale: null,
    targets: [],
    diff: null,
    ...over,
  } as ProposalReviewRow;
}

beforeEach(() => {
  approveProposalAction.mockReset().mockResolvedValue({ ok: true });
  rejectProposalAction.mockReset().mockResolvedValue({ ok: true });
  archiveMemoryAction.mockReset().mockResolvedValue({ ok: true });
  refresh.mockReset();
});

describe("ProposalCard — grooming update (single target)", () => {
  const updateRow = () =>
    row({
      action: "update",
      source: "grooming",
      rationale: "Corrected the sugar preference",
      targets: [memory({ id: "mem_target", title: "Coffee", body: "Espresso, no sugar." })],
      diff: "--- a\n+++ b\n@@ -1 +1 @@\n-Espresso, no sugar.\n+Espresso, one sugar.",
      proposal: memory({ title: "Coffee", body: "Espresso, one sugar." }),
    });

  it("renders the Update badge", () => {
    render(<ProposalCard row={updateRow()} />);
    expect(screen.getByText("Update")).toBeInTheDocument();
  });

  it("shows the source chip and the curator's rationale", () => {
    render(<ProposalCard row={updateRow()} />);
    expect(screen.getByText("grooming")).toBeInTheDocument();
    expect(screen.getByText(/Corrected the sugar preference/)).toBeInTheDocument();
  });

  it("shows the target's old body", () => {
    render(<ProposalCard row={updateRow()} />);
    expect(screen.getByText("Espresso, no sugar.")).toBeInTheDocument();
  });

  it("renders a DiffView between old and new", () => {
    render(<ProposalCard row={updateRow()} />);
    expect(screen.getByLabelText("Unified diff")).toBeInTheDocument();
  });

  it("labels Approve with the replace-one consequence", () => {
    render(<ProposalCard row={updateRow()} />);
    expect(screen.getByRole("button", { name: "Approve — replaces 1 memory" })).toBeInTheDocument();
  });

  it("approves through the server action and refreshes", async () => {
    render(<ProposalCard row={updateRow()} />);
    fireEvent.click(screen.getByRole("button", { name: /Approve/ }));
    await waitFor(() => expect(approveProposalAction).toHaveBeenCalledWith("mem_proposed"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("rejects through the server action", async () => {
    render(<ProposalCard row={updateRow()} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(rejectProposalAction).toHaveBeenCalledWith("mem_proposed"));
  });
});

describe("ProposalCard — intake create (no target)", () => {
  const createRow = () =>
    row({
      action: "create",
      source: "intake",
      rationale: "A new fact worth keeping",
      targets: [],
      diff: null,
      proposal: memory({ id: "mem_new", title: "New fact", body: "Worth keeping." }),
    });

  it("renders the honest 'New — needs filing' badge", () => {
    render(<ProposalCard row={createRow()} />);
    expect(screen.getByText("New — needs filing")).toBeInTheDocument();
  });

  it("renders NO diff", () => {
    render(<ProposalCard row={createRow()} />);
    expect(screen.queryByLabelText("Unified diff")).not.toBeInTheDocument();
  });

  it("shows the submission body and a 'review and file' note", () => {
    render(<ProposalCard row={createRow()} />);
    expect(screen.getByText("Worth keeping.")).toBeInTheDocument();
    // Apostrophe-agnostic: the editorial copy uses a typographic apostrophe.
    expect(screen.getByText(/wasn.t sure where this belongs/i)).toBeInTheDocument();
  });

  it("labels Approve plainly (nothing is archived)", () => {
    render(<ProposalCard row={createRow()} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  it("preserves the curator's guessed action as descriptive text for an intake supersede", () => {
    render(
      <ProposalCard
        row={row({
          action: "supersede",
          source: "intake",
          targets: [],
          diff: null,
          proposal: memory({ title: "Orphan", body: "no target recorded" }),
        })}
      />,
    );
    // The authoritative badge is still the honest one...
    expect(screen.getByText("New — needs filing")).toBeInTheDocument();
    // ...but the curator's guess is preserved somewhere as muted description.
    expect(screen.getByText(/supersede/)).toBeInTheDocument();
  });
});

describe("ProposalCard — merge (>= 2 targets)", () => {
  const mergeRow = () =>
    row({
      action: "merge",
      source: "grooming",
      rationale: "Collapsed two duplicates",
      targets: [
        memory({ id: "mem_a", title: "Dup A", body: "same fact, phrasing A" }),
        memory({ id: "mem_b", title: "Dup B", body: "same fact, phrasing B" }),
      ],
      diff: null,
      proposal: memory({ id: "mem_merged", title: "Merged fact", body: "the merged fact" }),
    });

  it("renders the Merge badge", () => {
    render(<ProposalCard row={mergeRow()} />);
    expect(screen.getByText("Merge")).toBeInTheDocument();
  });

  it("lists both source memories", () => {
    render(<ProposalCard row={mergeRow()} />);
    expect(screen.getByText("Dup A")).toBeInTheDocument();
    expect(screen.getByText("Dup B")).toBeInTheDocument();
  });

  it("renders the merged replacement and NO diff", () => {
    render(<ProposalCard row={mergeRow()} />);
    expect(screen.getByText("Merged fact")).toBeInTheDocument();
    expect(screen.queryByLabelText("Unified diff")).not.toBeInTheDocument();
  });

  it("labels Approve with the merges-N consequence", () => {
    render(<ProposalCard row={mergeRow()} />);
    expect(screen.getByRole("button", { name: "Approve — merges 2 memories" })).toBeInTheDocument();
  });
});

describe("ProposalCard — fail-soft", () => {
  it("does not throw when the approve action rejects (Librarian/network failure)", async () => {
    approveProposalAction.mockRejectedValueOnce(new Error("network down"));
    render(<ProposalCard row={row({ action: "create", source: "intake" })} />);
    fireEvent.click(screen.getByRole("button", { name: /Approve/ }));
    // The card stays mounted; the badge is still on screen.
    await waitFor(() => expect(approveProposalAction).toHaveBeenCalled());
    expect(screen.getByText("New — needs filing")).toBeInTheDocument();
  });
});
