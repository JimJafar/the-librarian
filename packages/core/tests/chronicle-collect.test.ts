import type {
  ChronicleCollectorDeps,
  ChronicleHandoffRead,
  ChroniclePeriod,
  CurationOperation,
  CurationRun,
  IntakeOperation,
  IntakeRun,
  Memory,
  VaultCommit,
} from "@librarian/core";
import { collectChronicleFacts } from "@librarian/core";
import { describe, expect, it, vi } from "vitest";

const PERIOD: ChroniclePeriod = {
  start: "2026-07-27T00:00:00.000Z",
  end: "2026-08-03T00:00:00.000Z",
  isoWeek: "2026-W31",
  partial: false,
};

function commit(index: number, date: string, subject = `memory: update mem_${index}`): VaultCommit {
  return {
    hash: `hash-${index}`,
    date,
    author: "Jim",
    subject,
    files: [`memories/mem_${index}.md`],
    renames: [],
  };
}

function memory(over: Partial<Memory> & Pick<Memory, "id">): Memory {
  return {
    id: over.id,
    agent_id: "agent-a",
    status: "active",
    tags: [],
    applies_to: [],
    supersedes: [],
    conflicts_with: [],
    flags: [],
    title: over.id,
    body: `Body for ${over.id}`,
    confidence: "high",
    created_at: "2026-07-20T10:00:00.000Z",
    updated_at: "2026-07-20T10:00:00.000Z",
    is_global: false,
    requires_approval: false,
    ...over,
  };
}

function deps(over: Partial<ChronicleCollectorDeps> = {}): ChronicleCollectorDeps {
  return {
    recentCommits: () => [],
    listMemories: () => [],
    readHandoffs: () => [],
    listCurationRuns: () => [],
    listCurationOperations: () => [],
    listIntakeRuns: () => [],
    listIntakeOperations: () => [],
    ...over,
  };
}

describe("collectChronicleFacts — git pagination and period boundaries", () => {
  it("walks beyond the 200-commit page and includes exactly [start, end)", () => {
    const inPeriod = Array.from({ length: 230 }, (_, index) =>
      commit(index, new Date(Date.parse(PERIOD.end) - (index + 1) * 60_000).toISOString()),
    );
    const atEnd = commit(900, PERIOD.end, "backup: snapshot");
    const atStart = commit(901, PERIOD.start, "handoff: store hdo-start");
    const beforeStart = commit(902, "2026-07-26T23:59:59.999Z");
    const rows = [atEnd, ...inPeriod, atStart, beforeStart];
    const recentCommits = vi.fn(({ limit = 200, before }: { limit?: number; before?: string }) => {
      const offset = before ? rows.findIndex((row) => row.hash === before) + 1 : 0;
      return rows.slice(offset, offset + limit);
    });

    const facts = collectChronicleFacts(PERIOD, deps({ recentCommits }));

    expect(facts.commits.entries).toHaveLength(231);
    expect(facts.commits.entries.some((row) => row.hash === atEnd.hash)).toBe(false);
    expect(facts.commits.entries.some((row) => row.hash === atStart.hash)).toBe(true);
    expect(facts.commits.entries.some((row) => row.hash === beforeStart.hash)).toBe(false);
    expect(facts.commits.bySource).toMatchObject({ curator: 230, agent: 1 });
    expect(recentCommits).toHaveBeenCalledTimes(2);
    expect(recentCommits.mock.calls[1]?.[0].before).toBe(rows[199]?.hash);
  });
});

describe("collectChronicleFacts — memories and handoffs", () => {
  it("separates created, updated, archived, and pending memories", () => {
    const facts = collectChronicleFacts(
      PERIOD,
      deps({
        listMemories: () => [
          memory({
            id: "new",
            created_at: "2026-07-28T10:00:00.000Z",
            updated_at: "2026-07-28T10:00:00.000Z",
          }),
          memory({ id: "changed", updated_at: "2026-07-29T10:00:00.000Z" }),
          memory({ id: "archived", status: "archived", updated_at: "2026-07-30T10:00:00.000Z" }),
          memory({ id: "proposal", status: "proposed", updated_at: "2026-07-31T10:00:00.000Z" }),
        ],
      }),
    );

    expect(facts.memories.created.map((row) => row.id)).toEqual(["new"]);
    expect(facts.memories.updated.map((row) => row.id)).toEqual(["changed", "proposal"]);
    expect(facts.memories.archived.map((row) => row.id)).toEqual(["archived"]);
    expect(facts.memories.pendingProposals).toBe(1);
  });

  it("collects created/claimed/open handoffs, extracts open questions, and skips malformed rows", () => {
    const handoffs: ChronicleHandoffRead[] = [
      {
        path: "handoffs/hdo-new.md",
        handoff: {
          handoff_id: "hdo-new",
          title: "New work",
          document_md:
            "## Start & intent\nShip it.\n\n## Open questions\nKeep the flag?\nTry blue first.\n\n## Tail\nDone.",
          project_key: "chronicle",
          source_ref: null,
          cwd: "/repo",
          created_by_agent_id: "agent-a",
          created_in_harness: "codex",
          tags: [],
          created_at: "2026-07-28T09:00:00.000Z",
          claimed_at: "2026-07-28T09:30:00.000Z",
          claimed_by: { agent_id: "agent-b", harness: "claude" },
        },
      },
      {
        path: "handoffs/hdo-old.md",
        handoff: {
          handoff_id: "hdo-old",
          title: "Old loose end",
          document_md: "## Open questions\nWho owns this?",
          project_key: null,
          source_ref: null,
          cwd: null,
          created_by_agent_id: null,
          created_in_harness: null,
          tags: [],
          created_at: "2026-07-20T09:00:00.000Z",
          claimed_at: null,
          claimed_by: null,
        },
      },
      { path: "handoffs/broken.md", error: "invalid_document" },
    ];

    const facts = collectChronicleFacts(PERIOD, deps({ readHandoffs: () => handoffs }));

    expect(facts.handoffs.created.map((row) => row.id)).toEqual(["hdo-new"]);
    expect(facts.handoffs.claimed[0]).toMatchObject({ id: "hdo-new", latencySeconds: 1800 });
    expect(facts.handoffs.stillOpenOlder.map((row) => row.id)).toEqual(["hdo-old"]);
    expect(facts.handoffs.openQuestions).toEqual([
      {
        handoffId: "hdo-new",
        path: "handoffs/hdo-new.md",
        markdown: "Keep the flag?\nTry blue first.",
      },
    ]);
    expect(facts.warnings).toContain("Skipped malformed handoff: handoffs/broken.md");
  });
});

describe("collectChronicleFacts — curator runs", () => {
  it("aggregates statuses, operation outcomes, and grooming token usage by model", () => {
    const curationRuns: CurationRun[] = [
      curationRun({
        id: "cur-1",
        status: "completed",
        model_provider: "openai",
        model_name: "gpt-5",
        usage_input_tokens: 100,
        usage_output_tokens: 20,
      }),
      curationRun({ id: "cur-2", status: "failed", created_at: "2026-07-30T10:00:00.000Z" }),
      curationRun({ id: "cur-old", created_at: "2026-07-20T10:00:00.000Z" }),
    ];
    const intakeRuns: IntakeRun[] = [
      intakeRun({ id: "int-1", status: "completed", consolidated: 2 }),
      intakeRun({ id: "int-2", status: "failed", created_at: "2026-07-31T10:00:00.000Z" }),
    ];
    const curationOps: CurationOperation[] = [
      curationOperation({ run_id: "cur-1", operation_type: "update", status: "applied" }),
      curationOperation({ run_id: "cur-2", operation_type: "noop", status: "failed" }),
    ];
    const intakeOps: IntakeOperation[] = [
      intakeOperation({ run_id: "int-1", action: "create", outcome: "applied" }),
      intakeOperation({ run_id: "int-2", action: "noop", outcome: "failed" }),
    ];

    const facts = collectChronicleFacts(
      PERIOD,
      deps({
        listCurationRuns: () => curationRuns,
        listCurationOperations: (runId) => curationOps.filter((row) => row.run_id === runId),
        listIntakeRuns: () => intakeRuns,
        listIntakeOperations: (runId) => intakeOps.filter((row) => row.run_id === runId),
      }),
    );

    expect(facts.runs.curation.statuses).toEqual({ completed: 1, failed: 1 });
    expect(facts.runs.curation.operations).toEqual({ "noop:failed": 1, "update:applied": 1 });
    expect(facts.runs.intake.statuses).toEqual({ completed: 1, failed: 1 });
    expect(facts.runs.intake.operations).toEqual({ "create:applied": 1, "noop:failed": 1 });
    expect(facts.runs.tokenUsage).toEqual([
      { provider: "openai", model: "gpt-5", inputTokens: 100, outputTokens: 20 },
    ]);
    expect(facts.runs.intakeTokenUsageAvailable).toBe(false);
  });
});

function curationRun(over: Partial<CurationRun> & Pick<CurationRun, "id">): CurationRun {
  return {
    id: over.id,
    status: "completed",
    trigger: "schedule",
    mode: "apply",
    project_key: null,
    input_hash: over.id,
    input_memory_ids: [],
    model_provider: null,
    model_name: null,
    usage_input_tokens: 0,
    usage_output_tokens: 0,
    summary: null,
    error: null,
    created_at: "2026-07-29T10:00:00.000Z",
    started_at: "2026-07-29T10:00:01.000Z",
    completed_at: "2026-07-29T10:00:02.000Z",
    ...over,
  };
}

function curationOperation(
  over: Partial<CurationOperation> & Pick<CurationOperation, "run_id">,
): CurationOperation {
  return {
    id: `${over.run_id}-op`,
    run_id: over.run_id,
    operation_type: "noop",
    status: "skipped",
    confidence: 1,
    source_memory_ids: [],
    target_memory_ids: [],
    title: null,
    rationale: "test",
    proposed_payload: {},
    applied_at: null,
    error: null,
    ...over,
  };
}

function intakeRun(over: Partial<IntakeRun> & Pick<IntakeRun, "id">): IntakeRun {
  return {
    id: over.id,
    status: "completed",
    trigger: "tick",
    consolidated: 0,
    judge_errors: 0,
    errored: 0,
    reclaimed: 0,
    summary: null,
    error: null,
    created_at: "2026-07-29T10:00:00.000Z",
    started_at: "2026-07-29T10:00:01.000Z",
    completed_at: "2026-07-29T10:00:02.000Z",
    ...over,
  };
}

function intakeOperation(
  over: Partial<IntakeOperation> & Pick<IntakeOperation, "run_id">,
): IntakeOperation {
  return {
    id: `${over.run_id}-op`,
    run_id: over.run_id,
    action: "noop",
    outcome: "skipped",
    confidence: 1,
    rationale: "test",
    source_id: null,
    target_id: null,
    ...over,
  };
}
