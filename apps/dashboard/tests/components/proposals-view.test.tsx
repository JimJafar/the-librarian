import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { groupProposalRows } from "@/components/memories/group-proposals";
import type { ProposalReviewRow } from "@/components/memories/types";

// The proposals view groups split siblings (they share supersedes[0], the
// shared source — run_id is grooming-only, so it's not the key) under that
// source and offers a one-click "Archive original" once the replacements are
// active; everything else renders as a standalone ProposalCard. The server
// actions + router are mocked for a fast component-only check.

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

const { ProposalsView } = await import("@/components/memories/proposals-view");

function memory(over: Partial<ProposalReviewRow["proposal"]> = {}): ProposalReviewRow["proposal"] {
  return {
    id: "mem_x",
    agent_id: "scribe",
    status: "proposed",
    tags: [],
    applies_to: [],
    supersedes: [],
    conflicts_with: [],
    flags: [],
    title: "Title",
    body: "Body",
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

// A split replacement, shaped like production: the shared source id lives ONLY
// on the resolved target (the endpoint reads it from curator_note.supersedes
// and exposes it via `targets`). Top-level Memory.supersedes is hardcoded [] in
// createMemory, so a realistic row leaves proposal.supersedes empty — the real
// grouping key is targets[0].id, not the dead top-level supersedes. `source`
// defaults to grooming but is parametrised so an intake split can be exercised.
function splitReplacement(
  id: string,
  sourceId: string,
  sourceTitle: string,
  source: string = "grooming",
): ProposalReviewRow {
  return row({
    action: "split",
    source,
    targets: [memory({ id: sourceId, title: sourceTitle, body: "the source body" })],
    diff: null,
    proposal: memory({ id, title: `${id} title`, body: `${id} body` }),
  });
}

beforeEach(() => {
  approveProposalAction.mockReset().mockResolvedValue({ ok: true });
  rejectProposalAction.mockReset().mockResolvedValue({ ok: true });
  archiveMemoryAction.mockReset().mockResolvedValue({ ok: true });
  refresh.mockReset();
});

describe("groupProposalRows", () => {
  it("groups split siblings that share a source target into one group", () => {
    const rows = [
      splitReplacement("mem_a", "mem_src", "Big note"),
      splitReplacement("mem_b", "mem_src", "Big note"),
      row({ action: "create", source: "intake", proposal: memory({ id: "mem_solo" }) }),
    ];
    const groups = groupProposalRows(rows);
    // One split group (2 replacements) + one standalone create.
    const splitGroups = groups.filter((g) => g.kind === "split");
    const singles = groups.filter((g) => g.kind === "single");
    expect(splitGroups).toHaveLength(1);
    expect(splitGroups[0]!.kind === "split" && splitGroups[0]!.replacements).toHaveLength(2);
    expect(singles).toHaveLength(1);
  });

  it("does not group split replacements that point at different sources", () => {
    const rows = [
      splitReplacement("mem_a", "mem_src_one", "Note one"),
      splitReplacement("mem_b", "mem_src_two", "Note two"),
    ];
    const groups = groupProposalRows(rows);
    // Two different sources → two lone splits, never one merged group.
    expect(groups.filter((g) => g.kind === "split")).toHaveLength(0);
    expect(groups.filter((g) => g.kind === "single")).toHaveLength(2);
  });

  it("does not group a lone split (a single replacement) — needs >= 2 siblings", () => {
    const groups = groupProposalRows([splitReplacement("mem_a", "mem_src", "Big note")]);
    // A single split replacement still renders, but as a normal split card, not
    // a grouped block with an archive-original affordance.
    expect(groups.filter((g) => g.kind === "split")).toHaveLength(0);
    expect(groups.filter((g) => g.kind === "single")).toHaveLength(1);
  });
});

describe("ProposalsView — split grouping + archive original", () => {
  const splitRows = () => [
    splitReplacement("mem_a", "mem_src", "Big note"),
    splitReplacement("mem_b", "mem_src", "Big note"),
  ];

  it("shows the shared source once above its replacements", () => {
    render(<ProposalsView rows={splitRows()} />);
    // The source title appears once (the grouped header), not per replacement.
    expect(screen.getAllByText("Big note")).toHaveLength(1);
  });

  it("renders both split replacements", () => {
    render(<ProposalsView rows={splitRows()} />);
    expect(screen.getByText("mem_a title")).toBeInTheDocument();
    expect(screen.getByText("mem_b title")).toBeInTheDocument();
  });

  it("offers an Archive original affordance that archives the shared source", async () => {
    render(<ProposalsView rows={splitRows()} />);
    fireEvent.click(screen.getByRole("button", { name: /Archive original/i }));
    await waitFor(() => expect(archiveMemoryAction).toHaveBeenCalledWith("mem_src"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("shows the empty state when there are no proposals", () => {
    render(<ProposalsView rows={[]} />);
    expect(screen.getByText(/No proposals pending/i)).toBeInTheDocument();
  });
});

describe("ProposalsView — split group source chip is derived, not hardcoded", () => {
  it("shows the 'grooming' chip for a grooming split group", () => {
    render(
      <ProposalsView
        rows={[
          splitReplacement("mem_a", "mem_src", "Big note", "grooming"),
          splitReplacement("mem_b", "mem_src", "Big note", "grooming"),
        ]}
      />,
    );
    expect(screen.getByText("grooming")).toBeInTheDocument();
    expect(screen.queryByText("intake")).not.toBeInTheDocument();
  });

  it("shows the 'intake' chip for an intake split group (not mislabelled grooming)", () => {
    render(
      <ProposalsView
        rows={[
          splitReplacement("mem_a", "mem_src", "Big note", "intake"),
          splitReplacement("mem_b", "mem_src", "Big note", "intake"),
        ]}
      />,
    );
    expect(screen.getByText("intake")).toBeInTheDocument();
    expect(screen.queryByText("grooming")).not.toBeInTheDocument();
  });
});
