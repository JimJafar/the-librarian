// Curator operation validation + risk classification (spec §10.5 + §11 risk).
//
// The context-dependent gate over already-schema-valid operations. These are the
// HARD GUARDS that §11 apply must never relax:
//   - referential: every referenced memory/session id is in the evidence bundle;
//   - slice-boundary: an op may not change visibility/project/scope or cross into
//     another slice;
//   - secret: an op carrying secret-looking content is rejected (never written);
//   - empty/duplicate: no empty memory, no duplicate of an active memory;
//   - resurrection: no create/merge that matches an archived tombstone (§9.1).
// Accepted ops are tagged protected? + a risk level (safe/normal/risky/protected)
// for the §11 apply decision. Reject reasons are value-free (audit hygiene).

import {
  type CuratorOperation,
  type EvidenceSlice,
  type MemoryEvidenceBundle,
  type MemoryEvidenceItem,
  type PrepassResult,
  type SessionEvidenceBundle,
  curationContentFingerprint,
  curationNormalizedTitle,
  validateOperations,
} from "@librarian/core";
import { describe, expect, it } from "vitest";

function memItem(id: string, over: Partial<MemoryEvidenceItem> = {}): MemoryEvidenceItem {
  return {
    id,
    title: `title ${id}`,
    body: `body ${id}`,
    category: "lessons",
    scope: "project",
    visibility: "common",
    projectKey: "proj-x",
    agentId: null,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function tomb(id: string, title: string, body: string): MemoryEvidenceBundle["tombstones"][number] {
  return {
    id,
    title,
    category: "lessons",
    scope: "project",
    visibility: "common",
    projectKey: "proj-x",
    agentId: null,
    archivedAt: "2026-01-01T00:00:00.000Z",
    archiveReason: null,
    contentFingerprint: curationContentFingerprint(title, body),
    normalizedTitle: curationNormalizedTitle(title),
  };
}

interface CtxParts {
  slice?: EvidenceSlice;
  active?: MemoryEvidenceItem[];
  proposed?: MemoryEvidenceItem[];
  tombstones?: MemoryEvidenceBundle["tombstones"];
  sessionIds?: string[];
  prepass?: PrepassResult;
}

function ctx(parts: CtxParts = {}) {
  const slice = parts.slice ?? { kind: "common_project", projectKey: "proj-x" };
  const memory: MemoryEvidenceBundle = {
    slice,
    activeMemories: parts.active ?? [],
    proposedMemories: parts.proposed ?? [],
    tombstones: parts.tombstones ?? [],
    truncatedMemories: false,
    truncatedFields: false,
    redactionCount: 0,
  };
  const sessions: SessionEvidenceBundle = {
    slice,
    sessions: (parts.sessionIds ?? []).map((id) => ({
      id,
      title: "s",
      status: "active",
      projectKey: "proj-x",
      createdByAgentId: "agent-a",
      currentAgentId: "agent-a",
      startSummary: null,
      rollingSummary: null,
      endSummary: null,
      nextSteps: [],
      lastActivityAt: "2026-01-01T00:00:00.000Z",
      events: [],
      truncatedEvents: false,
    })),
    truncatedSessions: false,
    redactionCount: 0,
  };
  return { slice, memory, sessions, prepass: parts.prepass ?? { findings: [] } };
}

const newMem = {
  title: "Fresh",
  body: "fresh body",
  category: "lessons" as const,
  visibility: "common" as const,
  scope: "project" as const,
  project_key: "proj-x",
};

function only(ops: CuratorOperation[], context: Parameters<typeof validateOperations>[1]) {
  return validateOperations(ops, context)[0]!.outcome;
}

describe("validateOperations — referential guard", () => {
  it("accepts an archive of an in-evidence active memory", () => {
    const outcome = only(
      [{ type: "archive", source_memory_ids: ["mem_a"], rationale: "dup", confidence: 0.95 }],
      ctx({ active: [memItem("mem_a")] }),
    );
    expect(outcome.decision).toBe("accept");
  });

  it("rejects an op referencing an unknown memory id", () => {
    const outcome = only(
      [{ type: "archive", source_memory_ids: ["mem_ghost"], rationale: "x", confidence: 0.9 }],
      ctx({ active: [memItem("mem_a")] }),
    );
    expect(outcome).toMatchObject({ decision: "reject" });
    expect((outcome as { reason: string }).reason).toMatch(/memory/i);
  });

  it("rejects a create referencing an unknown session id", () => {
    const outcome = only(
      [
        {
          type: "create",
          source_session_ids: ["ses_ghost"],
          memory: newMem,
          rationale: "x",
          confidence: 0.9,
        },
      ],
      ctx({ sessionIds: ["ses_real"] }),
    );
    expect(outcome).toMatchObject({ decision: "reject" });
    expect((outcome as { reason: string }).reason).toMatch(/session/i);
  });
});

describe("validateOperations — slice-boundary guard", () => {
  it("rejects an update.patch that changes visibility/project/scope", () => {
    for (const patch of [
      { visibility: "agent_private" },
      { project_key: "proj-y" },
      { scope: "global" },
    ]) {
      const outcome = only(
        [{ type: "update", source_memory_id: "mem_a", patch, rationale: "x", confidence: 0.9 }],
        ctx({ active: [memItem("mem_a")] }),
      );
      expect(outcome).toMatchObject({ decision: "reject" });
      expect((outcome as { reason: string }).reason).toMatch(/boundary/i);
    }
  });

  it("rejects a create whose memory crosses the slice visibility", () => {
    const outcome = only(
      [
        {
          type: "create",
          source_session_ids: [],
          memory: { ...newMem, visibility: "agent_private" },
          rationale: "x",
          confidence: 0.9,
        },
      ],
      ctx(),
    );
    expect(outcome).toMatchObject({ decision: "reject" });
  });

  it("rejects a common_global create that carries a project_key", () => {
    const outcome = only(
      [
        {
          type: "create",
          source_session_ids: [],
          memory: { ...newMem, project_key: "proj-x" },
          rationale: "x",
          confidence: 0.9,
        },
      ],
      ctx({ slice: { kind: "common_global" } }),
    );
    expect(outcome).toMatchObject({ decision: "reject" });
  });
});

describe("validateOperations — secret guard", () => {
  it("rejects an op carrying secret-looking content, without echoing the secret", () => {
    const SECRET = "FAKEVALIDATESECRET";
    const outcome = only(
      [
        {
          type: "create",
          source_session_ids: [],
          memory: { ...newMem, body: `token = "${SECRET}"` },
          rationale: "x",
          confidence: 0.9,
        },
      ],
      ctx(),
    );
    expect(outcome).toMatchObject({ decision: "reject" });
    expect((outcome as { reason: string }).reason).toMatch(/secret/i);
    expect((outcome as { reason: string }).reason).not.toContain(SECRET);
  });
});

describe("validateOperations — empty + duplicate guards", () => {
  it("rejects a whitespace-only memory as empty", () => {
    const outcome = only(
      [
        {
          type: "create",
          source_session_ids: [],
          memory: { ...newMem, title: "   ", body: "   " },
          rationale: "x",
          confidence: 0.9,
        },
      ],
      ctx(),
    );
    expect(outcome).toMatchObject({ decision: "reject" });
    expect((outcome as { reason: string }).reason).toMatch(/empty/i);
  });

  it("rejects a create that duplicates an existing active memory", () => {
    const outcome = only(
      [
        {
          type: "create",
          source_session_ids: [],
          memory: { ...newMem, title: "Dup", body: "dup body" },
          rationale: "x",
          confidence: 0.9,
        },
      ],
      ctx({ active: [memItem("mem_a", { title: "Dup", body: "dup body" })] }),
    );
    expect(outcome).toMatchObject({ decision: "reject" });
    expect((outcome as { reason: string }).reason).toMatch(/duplicate/i);
  });
});

describe("validateOperations — resurrection guard", () => {
  it("rejects a create whose content matches an archived tombstone", () => {
    const outcome = only(
      [
        {
          type: "create",
          source_session_ids: [],
          memory: { ...newMem, title: "Gone", body: "deleted content" },
          rationale: "x",
          confidence: 0.9,
        },
      ],
      ctx({ tombstones: [tomb("mem_dead", "Gone", "deleted content")] }),
    );
    expect(outcome).toMatchObject({ decision: "reject" });
    expect((outcome as { reason: string }).reason).toMatch(/resurrect|archived/i);
  });
});

describe("validateOperations — protected routing + risk", () => {
  it("flags a protected-category create as protected", () => {
    const outcome = only(
      [
        {
          type: "create",
          source_session_ids: ["ses_1"],
          memory: { ...newMem, category: "identity" },
          rationale: "x",
          confidence: 0.9,
        },
      ],
      ctx({ sessionIds: ["ses_1"] }),
    );
    expect(outcome).toMatchObject({ decision: "accept", isProtected: true, risk: "protected" });
  });

  it("flags a pure archive of a protected memory as protected", () => {
    const outcome = only(
      [{ type: "archive", source_memory_ids: ["mem_id"], rationale: "stale", confidence: 0.9 }],
      ctx({ active: [memItem("mem_id", { category: "relationship" })] }),
    );
    expect(outcome).toMatchObject({ decision: "accept", isProtected: true });
  });

  it("classifies an exact-duplicate archive as safe (per the pre-pass)", () => {
    const outcome = only(
      [{ type: "archive", source_memory_ids: ["mem_a"], rationale: "dup", confidence: 0.95 }],
      ctx({
        active: [memItem("mem_a"), memItem("mem_b")],
        prepass: {
          findings: [{ kind: "exact_duplicate", memoryIds: ["mem_a", "mem_b"], rationale: "d" }],
        },
      }),
    );
    expect(outcome).toMatchObject({ decision: "accept", risk: "safe" });
  });

  it("classifies a session-backed create as safe and an update as risky", () => {
    const createOutcome = only(
      [
        {
          type: "create",
          source_session_ids: ["ses_1"],
          memory: newMem,
          rationale: "x",
          confidence: 0.9,
        },
      ],
      ctx({ sessionIds: ["ses_1"] }),
    );
    expect(createOutcome).toMatchObject({ decision: "accept", risk: "safe" });

    const updateOutcome = only(
      [
        {
          type: "update",
          source_memory_id: "mem_a",
          patch: { body: "tweak" },
          rationale: "x",
          confidence: 0.9,
        },
      ],
      ctx({ active: [memItem("mem_a")] }),
    );
    expect(updateOutcome).toMatchObject({ decision: "accept", risk: "risky" });
  });
});

describe("validateOperations — batch", () => {
  it("returns one outcome per operation, in order", () => {
    const results = validateOperations(
      [
        { type: "noop", source_memory_ids: [], rationale: "ok", confidence: 0.5 },
        { type: "archive", source_memory_ids: ["ghost"], rationale: "x", confidence: 0.9 },
      ],
      ctx(),
    );
    expect(results).toHaveLength(2);
    expect(results[0]!.outcome.decision).toBe("accept");
    expect(results[1]!.outcome.decision).toBe("reject");
  });
});
