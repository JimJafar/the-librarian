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
const applyProposalPlanAction = vi.fn().mockResolvedValue({ ok: true });
const refresh = vi.fn();

vi.mock("@/app/(memories)/actions", () => ({
  approveProposalAction: (...args: unknown[]) => approveProposalAction(...args),
  rejectProposalAction: (id: string) => rejectProposalAction(id),
  archiveMemoryAction: (id: string) => archiveMemoryAction(id),
  applyProposalPlanAction: (id: string) => applyProposalPlanAction(id),
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
    plan: null,
    ...over,
  } as ProposalReviewRow;
}

// A plan-carrying row's plan (F2) — the enriched shape proposalsForReview returns.
function plan(over: Partial<NonNullable<ProposalReviewRow["plan"]>> = {}) {
  return {
    action: "augment",
    confidence: 0.7,
    guessed_target: { id: "mem_elaine", title: "Elaine", status: "active" },
    guessed_target_reason: null,
    planned_addition: "Now works at [[Acme]].",
    planned_title: null,
    planned_body: null,
    planned_tags: null,
    preview_diff: "--- a\n+++ b\n@@ -1 +1,2 @@\n Lives in Paris.\n+Now works at [[Acme]].",
    ...over,
  } as NonNullable<ProposalReviewRow["plan"]>;
}

beforeEach(() => {
  approveProposalAction.mockReset().mockResolvedValue({ ok: true });
  rejectProposalAction.mockReset().mockResolvedValue({ ok: true });
  archiveMemoryAction.mockReset().mockResolvedValue({ ok: true });
  applyProposalPlanAction.mockReset().mockResolvedValue({ ok: true });
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

describe("ProposalCard — single-target update with an identical body (empty diff)", () => {
  // A real grooming update whose body didn't change yields diff === "" (the
  // server returns "" for identical). The single-target layout must still
  // render — it must NOT fall back to the intake "needs filing" copy.
  const identicalRow = () =>
    row({
      action: "update",
      source: "grooming",
      rationale: "Re-affirmed, body unchanged",
      targets: [memory({ id: "mem_target", title: "Coffee", body: "Espresso, one sugar." })],
      diff: "",
      proposal: memory({ title: "Coffee", body: "Espresso, one sugar." }),
    });

  it("renders the single-target Current/Proposed layout, not the intake needs-filing copy", () => {
    render(<ProposalCard row={identicalRow()} />);
    expect(screen.getByText("Current memory")).toBeInTheDocument();
    expect(screen.getByText("Proposed")).toBeInTheDocument();
    expect(screen.queryByText(/wasn.t sure where this belongs/i)).not.toBeInTheDocument();
  });

  it("shows the DiffView's identical-versions note for an empty diff", () => {
    render(<ProposalCard row={identicalRow()} />);
    expect(screen.getByText(/No changes — versions are identical/i)).toBeInTheDocument();
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

describe("ProposalCard — plan panel (proposal-review rework F2)", () => {
  const augmentRow = () =>
    row({
      action: "augment",
      source: "intake",
      rationale: "extends the Elaine doc",
      proposal: memory({ id: "mem_plan", title: "Elaine works at Acme", body: "raw submission" }),
      plan: plan(),
    });

  it("renders the augment intent line with the resolved target title", () => {
    render(<ProposalCard row={augmentRow()} />);
    expect(screen.getByText(/Wanted to/)).toBeInTheDocument();
    expect(screen.getByText("augment", { selector: "em" })).toBeInTheDocument();
    expect(screen.getByText(/Elaine/, { selector: "strong" })).toBeInTheDocument();
  });

  it("shows the planned addition and the judgment confidence", () => {
    render(<ProposalCard row={augmentRow()} />);
    expect(screen.getByText("Now works at [[Acme]].")).toBeInTheDocument();
    expect(screen.getByText(/confidence 0\.70/)).toBeInTheDocument();
  });

  it("renders the plan's preview diff", () => {
    render(<ProposalCard row={augmentRow()} />);
    expect(screen.getByLabelText("Unified diff")).toBeInTheDocument();
  });

  it("still badges 'New — needs filing' — a guessed target is not a resolved one (D10)", () => {
    render(<ProposalCard row={augmentRow()} />);
    expect(screen.getByText("New — needs filing")).toBeInTheDocument();
  });

  it("does not show the 'wasn't sure' copy when the curator had a plan", () => {
    render(<ProposalCard row={augmentRow()} />);
    expect(screen.queryByText(/wasn.t sure where this belongs/i)).not.toBeInTheDocument();
  });

  it("renders the supersede intent with the planned replacement", () => {
    render(
      <ProposalCard
        row={row({
          action: "supersede",
          source: "intake",
          proposal: memory({ title: "Coffee update", body: "raw" }),
          plan: plan({
            action: "supersede",
            planned_addition: null,
            planned_title: "Coffee",
            planned_body: "Espresso, one sugar.",
            guessed_target: { id: "mem_coffee", title: "Coffee", status: "active" },
          }),
        })}
      />,
    );
    expect(screen.getByText("replace", { selector: "em" })).toBeInTheDocument();
    expect(screen.getByText("Espresso, one sugar.")).toBeInTheDocument();
  });

  it("renders the create intent with the curated title/body", () => {
    render(
      <ProposalCard
        row={row({
          action: "create",
          source: "intake",
          proposal: memory({ title: "raw title", body: "raw body" }),
          plan: plan({
            action: "create",
            guessed_target: null,
            planned_addition: null,
            planned_title: "Elaine — Piano Teacher",
            planned_body: "Teaches on Tuesdays.",
            planned_tags: ["person"],
            preview_diff: null,
          }),
        })}
      />,
    );
    expect(screen.getByText(/file a new memory/)).toBeInTheDocument();
    expect(screen.getByText("Elaine — Piano Teacher")).toBeInTheDocument();
    expect(screen.getByText("Teaches on Tuesdays.")).toBeInTheDocument();
  });

  it("explains an unresolvable guessed target instead of showing a preview", () => {
    render(
      <ProposalCard
        row={row({
          action: "augment",
          source: "intake",
          proposal: memory({ title: "Orphan", body: "raw" }),
          plan: plan({
            guessed_target: null,
            guessed_target_reason: "not_found",
            preview_diff: null,
          }),
        })}
      />,
    );
    expect(screen.getByText(/no longer exists/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Unified diff")).not.toBeInTheDocument();
  });

  it("explains an archived guessed target", () => {
    render(
      <ProposalCard
        row={row({
          action: "augment",
          source: "intake",
          proposal: memory({ title: "Late", body: "raw" }),
          plan: plan({
            guessed_target: { id: "mem_x", title: "Retired doc", status: "archived" },
            guessed_target_reason: "archived",
          }),
        })}
      />,
    );
    expect(screen.getByText(/archived/i)).toBeInTheDocument();
  });

  it("a plan-less proposal renders no plan panel (exactly today's card)", () => {
    render(<ProposalCard row={row({ action: "create", source: "intake" })} />);
    expect(screen.queryByText(/Wanted to/)).not.toBeInTheDocument();
    expect(screen.getByText(/wasn.t sure where this belongs/i)).toBeInTheDocument();
  });
});

describe("ProposalCard — apply-the-plan affordance (F3)", () => {
  const augmentRow = () =>
    row({
      action: "augment",
      source: "intake",
      proposal: memory({ id: "mem_plan", title: "Elaine works at Acme", body: "raw" }),
      plan: plan(),
    });

  it("shows 'Approve as augment of ‹target›' as the primary action", () => {
    render(<ProposalCard row={augmentRow()} />);
    expect(
      screen.getByRole("button", { name: "Approve as augment of Elaine" }),
    ).toBeInTheDocument();
  });

  it("executes the persisted plan through the server action and refreshes", async () => {
    render(<ProposalCard row={augmentRow()} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve as augment of Elaine" }));
    await waitFor(() => expect(applyProposalPlanAction).toHaveBeenCalledWith("mem_plan"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("keeps 'Approve as new' (plain approve) and Reject available", async () => {
    render(<ProposalCard row={augmentRow()} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve as new" }));
    await waitFor(() => expect(approveProposalAction).toHaveBeenCalledWith("mem_plan"));
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
  });

  it("labels a supersede plan 'Approve — replaces ‹target›'", () => {
    render(
      <ProposalCard
        row={row({
          action: "supersede",
          source: "intake",
          proposal: memory({ id: "mem_sup", title: "Coffee update", body: "raw" }),
          plan: plan({
            action: "supersede",
            planned_addition: null,
            planned_title: "Coffee",
            planned_body: "Espresso, one sugar.",
            guessed_target: { id: "mem_coffee", title: "Coffee", status: "active" },
          }),
        })}
      />,
    );
    expect(screen.getByRole("button", { name: "Approve — replaces Coffee" })).toBeInTheDocument();
  });

  it("disables the affordance with the reason when the target is unresolvable", () => {
    render(
      <ProposalCard
        row={row({
          action: "augment",
          source: "intake",
          proposal: memory({ id: "mem_orphan", title: "Orphan", body: "raw" }),
          plan: plan({
            guessed_target: null,
            guessed_target_reason: "not_found",
            preview_diff: null,
          }),
        })}
      />,
    );
    const button = screen.getByRole("button", { name: /Approve as augment/ });
    expect(button).toBeDisabled();
  });

  it("disables the affordance when the target was archived since judgment", () => {
    render(
      <ProposalCard
        row={row({
          action: "augment",
          source: "intake",
          proposal: memory({ id: "mem_late", title: "Late", body: "raw" }),
          plan: plan({
            guessed_target: { id: "mem_x", title: "Retired doc", status: "archived" },
            guessed_target_reason: "archived",
          }),
        })}
      />,
    );
    expect(screen.getByRole("button", { name: /Approve as augment/ })).toBeDisabled();
  });

  it("surfaces a teaching error on the card when applying the plan fails server-side", async () => {
    applyProposalPlanAction.mockResolvedValueOnce({
      ok: false,
      error: "The memory the curator wanted to augment no longer exists",
    });
    render(<ProposalCard row={augmentRow()} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve as augment of Elaine" }));
    await waitFor(() => expect(screen.getByText(/no longer exists/)).toBeInTheDocument());
  });

  it("offers no apply-plan affordance on a create plan (D11 owns that path)", () => {
    render(
      <ProposalCard
        row={row({
          action: "create",
          source: "intake",
          proposal: memory({ title: "raw", body: "raw" }),
          plan: plan({
            action: "create",
            guessed_target: null,
            planned_addition: null,
            planned_title: "Curated",
            planned_body: "Curated body.",
            preview_diff: null,
          }),
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: /augment|replaces/ })).not.toBeInTheDocument();
  });

  it("offers no apply-plan affordance on a plan-less proposal", () => {
    render(<ProposalCard row={row({ action: "create", source: "intake" })} />);
    expect(screen.queryByRole("button", { name: /augment|replaces/ })).not.toBeInTheDocument();
  });
});

describe("ProposalCard — create-plan approve-with-patch (D11)", () => {
  const createPlanRow = () =>
    row({
      action: "create",
      source: "intake",
      proposal: memory({ id: "mem_create", title: "raw first line", body: "raw submission" }),
      plan: plan({
        action: "create",
        guessed_target: null,
        planned_addition: null,
        planned_title: "Elaine — Piano Teacher",
        planned_body: "Teaches on Tuesdays.",
        planned_tags: ["person"],
        preview_diff: null,
      }),
    });

  it("default Approve sends the curated title/body/tags as the patch", async () => {
    render(<ProposalCard row={createPlanRow()} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve curated version" }));
    await waitFor(() =>
      expect(approveProposalAction).toHaveBeenCalledWith("mem_create", {
        title: "Elaine — Piano Teacher",
        body: "Teaches on Tuesdays.",
        tags: ["person"],
      }),
    );
  });

  it("'Approve raw submission' sends no patch (today's behaviour)", async () => {
    render(<ProposalCard row={createPlanRow()} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve raw submission" }));
    await waitFor(() => expect(approveProposalAction).toHaveBeenCalledWith("mem_create"));
  });

  it("a plan-less proposal keeps the single Approve (no raw-submission secondary)", () => {
    render(<ProposalCard row={row({ action: "create", source: "intake" })} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Approve raw submission" }),
    ).not.toBeInTheDocument();
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
