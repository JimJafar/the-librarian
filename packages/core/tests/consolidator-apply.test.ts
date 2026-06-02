// Consolidator apply step (plan 036 Phase 4 / spec 035 §F5). Executes a routed
// ConsolidationPlan against a fake store and pins the decision × action → store
// mutation mapping, the no-clobber guard on augment, and that a store rejection
// becomes a `rejected` outcome rather than a throw.

import {
  type ConsolidationJudgment,
  type ConsolidationPlan,
  type ConsolidatorApplyStore,
  applyConsolidationPlan,
} from "@librarian/core";
import { describe, expect, it } from "vitest";

function fakeStore(seed: Record<string, { title: string; body: string }> = {}) {
  const docs = new Map(Object.entries(seed));
  const calls = {
    create: [] as { input: Record<string, unknown>; options?: Record<string, unknown> }[],
    update: [] as { id: string; patch?: Record<string, unknown> }[],
    archive: [] as string[],
  };
  let n = 0;
  const store: ConsolidatorApplyStore = {
    createMemory: (input, options) => {
      const id = `mem_new_${n++}`;
      calls.create.push({ input, ...(options ? { options } : {}) });
      docs.set(id, { title: String(input.title ?? ""), body: String(input.body ?? "") });
      return { memory: { id } };
    },
    updateMemory: (id, patch) => {
      calls.update.push({ id, ...(patch ? { patch } : {}) });
      const d = docs.get(id);
      if (d) docs.set(id, { ...d, ...(patch as Partial<typeof d>) });
      return null;
    },
    archiveMemory: (id) => {
      calls.archive.push(id);
      return null;
    },
    getMemory: (id) => docs.get(id) ?? null,
  };
  return { store, calls, docs };
}

function plan(
  decision: ConsolidationPlan["decision"],
  judgment: Partial<ConsolidationJudgment> & { action: string },
): ConsolidationPlan {
  return {
    decision,
    judgment: { rationale: "r", confidence: 0.9, ...judgment } as ConsolidationJudgment,
  };
}

const deps = (store: ConsolidatorApplyStore, submissionText = "A new fact about Anna.") => ({
  store,
  submissionText,
  actorId: "system-consolidator",
});

describe("applyConsolidationPlan", () => {
  it("skip → does nothing", () => {
    const { store, calls } = fakeStore();
    expect(applyConsolidationPlan(plan("skip", { action: "noop" }), deps(store))).toEqual({
      kind: "skipped",
    });
    expect(calls.create.length + calls.update.length + calls.archive.length).toBe(0);
  });

  it("auto_apply create → createMemory with the judged title/body/tags", () => {
    const { store, calls } = fakeStore();
    const out = applyConsolidationPlan(
      plan("auto_apply", {
        action: "create",
        title: "Anna",
        body: "Lives in Paris.",
        tags: ["person"],
      }),
      deps(store),
    );
    expect(out).toMatchObject({ kind: "created" });
    expect(calls.create[0]?.input).toMatchObject({
      title: "Anna",
      body: "Lives in Paris.",
      tags: ["person"],
      agent_id: "system-consolidator",
    });
  });

  it("auto_apply augment → updateMemory with an appended body that preserves the original", () => {
    const { store, calls } = fakeStore({ mem_anna: { title: "Anna", body: "Lives in Paris." } });
    const out = applyConsolidationPlan(
      plan("auto_apply", {
        action: "augment",
        target_id: "mem_anna",
        addition: "Now works at [[Acme]].",
      }),
      deps(store),
    );
    expect(out).toEqual({ kind: "augmented", id: "mem_anna" });
    const body = String(calls.update[0]?.patch?.body ?? "");
    expect(body.startsWith("Lives in Paris.")).toBe(true); // no-clobber
    expect(body).toContain("[[Acme]]");
  });

  it("auto_apply augment with a missing target → rejected", () => {
    const { store } = fakeStore();
    expect(
      applyConsolidationPlan(
        plan("auto_apply", { action: "augment", target_id: "ghost", addition: "x" }),
        deps(store),
      ),
    ).toEqual({ kind: "rejected", reason: "augment target missing" });
  });

  it("auto_apply supersede → updateMemory replacing title + body", () => {
    const { store, calls } = fakeStore({ mem_anna: { title: "Anna", body: "Works at Globex." } });
    const out = applyConsolidationPlan(
      plan("auto_apply", {
        action: "supersede",
        target_id: "mem_anna",
        title: "Anna",
        body: "Works at Acme (was Globex).",
      }),
      deps(store),
    );
    expect(out).toEqual({ kind: "superseded", id: "mem_anna" });
    expect(calls.update[0]?.patch).toMatchObject({
      title: "Anna",
      body: "Works at Acme (was Globex).",
    });
  });

  it("auto_apply archive → archiveMemory (or rejected if missing)", () => {
    const { store, calls } = fakeStore({ mem_old: { title: "Old", body: "Stale." } });
    expect(
      applyConsolidationPlan(
        plan("auto_apply", { action: "archive", target_id: "mem_old" }),
        deps(store),
      ),
    ).toEqual({ kind: "archived", id: "mem_old" });
    expect(calls.archive).toEqual(["mem_old"]);

    const empty = fakeStore();
    expect(
      applyConsolidationPlan(
        plan("auto_apply", { action: "archive", target_id: "ghost" }),
        deps(empty.store),
      ),
    ).toEqual({ kind: "rejected", reason: "archive target missing" });
  });

  it("create_new → a new active doc from the submission, title derived", () => {
    const { store, calls } = fakeStore();
    const out = applyConsolidationPlan(
      plan("create_new", { action: "augment", target_id: "mem_x", addition: "unused" }),
      deps(store, "Anna moved to Berlin.\nMore detail."),
    );
    expect(out).toMatchObject({ kind: "created_new" });
    expect(calls.create[0]?.input).toMatchObject({
      title: "Anna moved to Berlin.",
      body: "Anna moved to Berlin.\nMore detail.",
    });
    // The target was NOT touched.
    expect(calls.update.length).toBe(0);
  });

  it("propose → a proposed doc from the submission, target untouched", () => {
    const { store, calls } = fakeStore({ mem_anna: { title: "Anna", body: "x" } });
    const out = applyConsolidationPlan(
      plan("propose", { action: "supersede", target_id: "mem_anna", title: "t", body: "b" }),
      deps(store, "Possibly Anna changed jobs."),
    );
    expect(out).toMatchObject({ kind: "proposed" });
    expect(calls.create[0]?.input).toMatchObject({ body: "Possibly Anna changed jobs." });
    expect(calls.create[0]?.options?.curator_note).toMatchObject({ proposed_action: "supersede" });
    // The load-bearing bit: requires_approval is what lands it at status=proposed
    // (awaiting human review) instead of live/active recall.
    expect(calls.create[0]?.options?.requires_approval).toBe(true);
    expect(calls.update.length).toBe(0);
  });

  it("create_new does NOT request approval (it's an active doc)", () => {
    const { store, calls } = fakeStore();
    applyConsolidationPlan(
      plan("create_new", { action: "augment", target_id: "x", addition: "a" }),
      deps(store, "A fact."),
    );
    expect(calls.create[0]?.options?.requires_approval).toBeUndefined();
  });

  it("redacts a secret-shaped rationale before persisting it (parity with the curator)", () => {
    const { store, calls } = fakeStore();
    // Assemble the keyword at runtime so no literal secret-assignment sits in source.
    const kw = "to" + "ken";
    applyConsolidationPlan(
      plan("auto_apply", {
        action: "create",
        title: "t",
        body: "b",
        tags: [],
        rationale: `${kw} = "leakvalue123"`,
      }),
      deps(store),
    );
    const note = calls.create[0]?.options?.curator_note as { rationale?: string };
    expect(note.rationale).not.toContain("leakvalue123");
    expect(note.rationale).toContain("[REDACTED:secret]");
  });

  it("create_new inherits the submitter's scope from submissionHints", () => {
    const { store, calls } = fakeStore();
    applyConsolidationPlan(
      plan("create_new", { action: "augment", target_id: "x", addition: "a" }),
      {
        store,
        submissionText: "A fact.",
        actorId: "system-consolidator",
        submissionHints: {
          agentId: "agent-a",
          projectKey: "proj-x",
          tags: ["t1"],
          appliesTo: ["Anna"],
        },
      },
    );
    expect(calls.create[0]?.input).toMatchObject({
      agent_id: "agent-a",
      project_key: "proj-x",
      tags: ["t1"],
      applies_to: ["Anna"], // the caller's targeting signal the judge can't re-derive
    });
  });

  it("create inherits the submitter's scope but keeps the judge's tags", () => {
    const { store, calls } = fakeStore();
    applyConsolidationPlan(
      plan("auto_apply", { action: "create", title: "T", body: "B", tags: ["judged"] }),
      {
        store,
        submissionText: "x",
        actorId: "system-consolidator",
        submissionHints: { agentId: "agent-a", projectKey: "proj-x", tags: ["ignored"] },
      },
    );
    expect(calls.create[0]?.input).toMatchObject({
      agent_id: "agent-a",
      project_key: "proj-x",
      tags: ["judged"], // the judge curated these; the submission's tags don't override
    });
  });

  it("an augment ignores submissionHints — it edits the target's body only", () => {
    const { store, calls } = fakeStore({ mem_anna: { title: "Anna", body: "Lives in Paris." } });
    applyConsolidationPlan(
      plan("auto_apply", { action: "augment", target_id: "mem_anna", addition: "moved" }),
      {
        store,
        submissionText: "x",
        actorId: "system-consolidator",
        submissionHints: { agentId: "agent-a", projectKey: "proj-x" },
      },
    );
    expect(Object.keys(calls.update[0]?.patch ?? {})).toEqual(["body"]); // no agent_id/project_key
  });

  it("a store rejection (e.g. protected target) becomes a rejected outcome, not a throw", () => {
    const { store } = fakeStore({ mem_p: { title: "P", body: "x" } });
    store.updateMemory = () => {
      throw new Error("Protected memories must be changed through a proposal workflow.");
    };
    const out = applyConsolidationPlan(
      plan("auto_apply", { action: "augment", target_id: "mem_p", addition: "y" }),
      deps(store),
    );
    expect(out.kind).toBe("rejected");
    expect(out).toMatchObject({ reason: expect.stringContaining("Protected") });
  });
});
