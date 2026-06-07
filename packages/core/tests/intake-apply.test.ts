// Intake apply step (plan 036 Phase 4 / spec 035 §F5). Executes a routed
// IntakePlan against a fake store and pins the decision × action → store
// mutation mapping, the no-clobber guard on augment, and that a store rejection
// becomes a `rejected` outcome rather than a throw.

import {
  type IntakeJudgment,
  type IntakePlan,
  type IntakeApplyStore,
  applyIntakePlan,
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
  const store: IntakeApplyStore = {
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
  decision: IntakePlan["decision"],
  judgment: Partial<IntakeJudgment> & { action: string },
): IntakePlan {
  return {
    decision,
    judgment: { rationale: "r", confidence: 0.9, ...judgment } as IntakeJudgment,
  };
}

const deps = (store: IntakeApplyStore, submissionText = "A new fact about Anna.") => ({
  store,
  submissionText,
  actorId: "system-consolidator",
});

describe("applyIntakePlan", () => {
  it("skip → does nothing", () => {
    const { store, calls } = fakeStore();
    expect(applyIntakePlan(plan("skip", { action: "noop" }), deps(store))).toEqual({
      kind: "skipped",
    });
    expect(calls.create.length + calls.update.length + calls.archive.length).toBe(0);
  });

  it("auto_apply create → createMemory with the judged title/body/tags", () => {
    const { store, calls } = fakeStore();
    const out = applyIntakePlan(
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
    const out = applyIntakePlan(
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
      applyIntakePlan(
        plan("auto_apply", { action: "augment", target_id: "ghost", addition: "x" }),
        deps(store),
      ),
    ).toEqual({ kind: "rejected", reason: "augment target missing" });
  });

  it("auto_apply supersede → updateMemory replacing title + body", () => {
    const { store, calls } = fakeStore({ mem_anna: { title: "Anna", body: "Works at Globex." } });
    const out = applyIntakePlan(
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
      applyIntakePlan(plan("auto_apply", { action: "archive", target_id: "mem_old" }), deps(store)),
    ).toEqual({ kind: "archived", id: "mem_old" });
    expect(calls.archive).toEqual(["mem_old"]);

    const empty = fakeStore();
    expect(
      applyIntakePlan(
        plan("auto_apply", { action: "archive", target_id: "ghost" }),
        deps(empty.store),
      ),
    ).toEqual({ kind: "rejected", reason: "archive target missing" });
  });

  it("create_new → a new active doc from the submission, title derived", () => {
    const { store, calls } = fakeStore();
    const out = applyIntakePlan(
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
    const out = applyIntakePlan(
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
    applyIntakePlan(
      plan("create_new", { action: "augment", target_id: "x", addition: "a" }),
      deps(store, "A fact."),
    );
    expect(calls.create[0]?.options?.requires_approval).toBeUndefined();
  });

  it("redacts a secret-shaped rationale before persisting it (parity with the curator)", () => {
    const { store, calls } = fakeStore();
    // Assemble the keyword at runtime so no literal secret-assignment sits in source.
    const kw = "to" + "ken";
    applyIntakePlan(
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
    applyIntakePlan(plan("create_new", { action: "augment", target_id: "x", addition: "a" }), {
      store,
      submissionText: "A fact.",
      actorId: "system-consolidator",
      submissionHints: {
        agentId: "agent-a",
        projectKey: "proj-x",
        tags: ["t1"],
        appliesTo: ["Anna"],
      },
    });
    expect(calls.create[0]?.input).toMatchObject({
      agent_id: "agent-a",
      project_key: "proj-x",
      tags: ["t1"],
      applies_to: ["Anna"], // the caller's targeting signal the judge can't re-derive
    });
  });

  it("create inherits the submitter's scope but keeps the judge's tags", () => {
    const { store, calls } = fakeStore();
    applyIntakePlan(
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
    applyIntakePlan(
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
    const out = applyIntakePlan(
      plan("auto_apply", { action: "augment", target_id: "mem_p", addition: "y" }),
      deps(store),
    );
    expect(out.kind).toBe("rejected");
    expect(out).toMatchObject({ reason: expect.stringContaining("Protected") });
  });
});

describe("applyIntakePlan — intake split (always proposed, never auto-applied)", () => {
  const splitJudgment = {
    action: "split" as const,
    target_id: "mem_overloaded",
    replacements: [
      { title: "Anna", body: "About Anna.", tags: ["person"] },
      { title: "Bob", body: "About Bob.", tags: [] },
    ],
  };

  it("routes a split to PROPOSED replacements (requires_approval), source left active", () => {
    const { store, calls } = fakeStore({
      mem_overloaded: { title: "Anna and Bob", body: "mixed" },
    });
    const out = applyIntakePlan(plan("propose", splitJudgment), deps(store));
    expect(out.kind).toBe("proposed");
    // Two replacement docs were created, each requiring approval (status=proposed).
    expect(calls.create.length).toBe(2);
    for (const c of calls.create) {
      expect(c.options?.requires_approval).toBe(true);
      expect(c.options?.curator_note).toMatchObject({ proposed_action: "split" });
      expect((c.options?.curator_note as { supersedes?: string[] }).supersedes).toEqual([
        "mem_overloaded",
      ]);
    }
    // The source candidate is NOT archived — a human archives it after accepting.
    expect(calls.archive.length).toBe(0);
  });

  it("never auto-applies a split, even at confidence 1.0", () => {
    const { store, calls } = fakeStore({
      mem_overloaded: { title: "Anna and Bob", body: "mixed" },
    });
    // Force a fully-confident split through the auto_apply lane: it must STILL
    // propose, never auto-apply (intake lacks grooming's whole-slice context).
    const out = applyIntakePlan(
      { decision: "auto_apply", judgment: { confidence: 1, rationale: "r", ...splitJudgment } },
      deps(store),
    );
    expect(out.kind).toBe("proposed");
    expect(calls.archive.length).toBe(0); // never mutates the live source
    for (const c of calls.create) expect(c.options?.requires_approval).toBe(true);
  });

  it("rejects a split whose target is missing from the store (target ∈ candidates guard)", () => {
    const { store, calls } = fakeStore(); // no mem_overloaded
    const out = applyIntakePlan(plan("propose", splitJudgment), deps(store));
    expect(out).toEqual({ kind: "rejected", reason: "split target missing" });
    expect(calls.create.length).toBe(0);
    expect(calls.archive.length).toBe(0);
  });

  it("the split's proposed replacements carry the judge's title/body/tags + submitter scope", () => {
    const { store, calls } = fakeStore({
      mem_overloaded: { title: "Anna and Bob", body: "mixed" },
    });
    applyIntakePlan(plan("propose", splitJudgment), {
      store,
      submissionText: "x",
      actorId: "system-consolidator",
      submissionHints: { agentId: "agent-a", projectKey: "proj-x" },
    });
    expect(calls.create[0]?.input).toMatchObject({
      title: "Anna",
      body: "About Anna.",
      tags: ["person"],
      agent_id: "agent-a",
      project_key: "proj-x",
    });
  });

  it("redacts a secret-shaped rationale on the split's proposed replacements", () => {
    const { store, calls } = fakeStore({
      mem_overloaded: { title: "Anna and Bob", body: "mixed" },
    });
    const kw = "to" + "ken";
    applyIntakePlan(
      {
        decision: "propose",
        judgment: { rationale: `${kw} = "leakvalue123"`, confidence: 0.9, ...splitJudgment },
      },
      deps(store),
    );
    const note = calls.create[0]?.options?.curator_note as { rationale?: string };
    expect(note.rationale).not.toContain("leakvalue123");
    expect(note.rationale).toContain("[REDACTED:secret]");
  });
});

// ── Under-evaluation force-propose (spec 044 D-3) ────────────────────────────
//
// While the intake addendum is under_evaluation, NO op auto-applies: a would-be
// auto-apply is routed to a PROPOSAL (tagged with the eval version) and a would-be
// auto-archive is SKIPPED (archive is not proposable — the wrinkle). noop stays
// noop. When accepted (the default) behaviour is byte-identical to before D3a.
describe("applyIntakePlan — under_evaluation force-propose (spec 044 D-3)", () => {
  const evalDeps = (store: IntakeApplyStore, submissionText = "Anna moved to Berlin.") => ({
    store,
    submissionText,
    actorId: "system-consolidator",
    underEvaluation: true,
    addendumVersion: "abc123def",
  });

  it("auto_apply create → PROPOSED (not created), tagged with the eval version", () => {
    const { store, calls } = fakeStore();
    const out = applyIntakePlan(
      plan("auto_apply", { action: "create", title: "Anna", body: "Lives in Berlin.", tags: [] }),
      evalDeps(store),
    );
    expect(out).toMatchObject({ kind: "proposed" }); // NOT "created"
    expect(calls.create[0]?.options?.requires_approval).toBe(true);
    expect(calls.create[0]?.options?.curator_note).toMatchObject({
      proposed_action: "create",
      addendum_version: "abc123def",
    });
    // The submission is filed as-is (the judge's curated title/body are dropped on
    // the propose lane — a human decides from the raw submission).
    expect(calls.create[0]?.input).toMatchObject({ body: "Anna moved to Berlin." });
  });

  it("auto_apply augment → PROPOSED (target untouched), tagged", () => {
    const { store, calls } = fakeStore({ mem_anna: { title: "Anna", body: "Lives in Paris." } });
    const out = applyIntakePlan(
      plan("auto_apply", { action: "augment", target_id: "mem_anna", addition: "moved" }),
      evalDeps(store),
    );
    expect(out).toMatchObject({ kind: "proposed" });
    expect(calls.update.length).toBe(0); // the existing doc is NOT mutated
    expect(calls.create[0]?.options?.curator_note).toMatchObject({
      proposed_action: "augment",
      addendum_version: "abc123def",
    });
  });

  it("auto_apply supersede → PROPOSED (target untouched), tagged", () => {
    const { store, calls } = fakeStore({ mem_anna: { title: "Anna", body: "Works at Globex." } });
    const out = applyIntakePlan(
      plan("auto_apply", { action: "supersede", target_id: "mem_anna", title: "t", body: "b" }),
      evalDeps(store),
    );
    expect(out).toMatchObject({ kind: "proposed" });
    expect(calls.update.length).toBe(0);
    expect(calls.create[0]?.options?.curator_note).toMatchObject({
      proposed_action: "supersede",
      addendum_version: "abc123def",
    });
  });

  it("auto_apply archive → SKIPPED, not proposed (the archive wrinkle)", () => {
    const { store, calls } = fakeStore({ mem_old: { title: "Old", body: "Stale." } });
    const out = applyIntakePlan(
      plan("auto_apply", { action: "archive", target_id: "mem_old" }),
      evalDeps(store),
    );
    expect(out).toEqual({ kind: "skipped" }); // NOT proposed, NOT archived
    expect(calls.archive.length).toBe(0);
    expect(calls.create.length).toBe(0);
  });

  it("create_new (a would-be ACTIVE doc) → PROPOSED, tagged", () => {
    const { store, calls } = fakeStore();
    const out = applyIntakePlan(
      plan("create_new", { action: "augment", target_id: "x", addition: "a" }),
      evalDeps(store, "A fresh fact."),
    );
    expect(out).toMatchObject({ kind: "proposed" }); // NOT created_new (active)
    expect(calls.create[0]?.options?.requires_approval).toBe(true);
    expect(calls.create[0]?.options?.curator_note).toMatchObject({ addendum_version: "abc123def" });
  });

  it("split stays PROPOSED and is tagged with the eval version", () => {
    const { store, calls } = fakeStore({ mem_overloaded: { title: "A and B", body: "mixed" } });
    const out = applyIntakePlan(
      plan("propose", {
        action: "split",
        target_id: "mem_overloaded",
        replacements: [
          { title: "A", body: "about a", tags: [] },
          { title: "B", body: "about b", tags: [] },
        ],
      }),
      evalDeps(store),
    );
    expect(out).toMatchObject({ kind: "proposed" });
    expect(calls.archive.length).toBe(0); // source stays active (a proposed split)
    expect(calls.create[0]?.options?.curator_note).toMatchObject({
      proposed_action: "split",
      addendum_version: "abc123def",
    });
  });

  it("noop / skip stays skipped (nothing proposed)", () => {
    const { store, calls } = fakeStore();
    expect(applyIntakePlan(plan("skip", { action: "noop" }), evalDeps(store))).toEqual({
      kind: "skipped",
    });
    expect(calls.create.length).toBe(0);
  });

  it("even at confidence 1.0 a create never auto-applies under evaluation (defence-in-depth)", () => {
    const { store, calls } = fakeStore();
    const out = applyIntakePlan(
      plan("auto_apply", {
        action: "create",
        title: "T",
        body: "B",
        tags: [],
        confidence: 1,
      }),
      evalDeps(store),
    );
    expect(out).toMatchObject({ kind: "proposed" });
    expect(calls.create[0]?.options?.requires_approval).toBe(true);
  });

  it("under_evaluation without a version tags nothing (no addendum_version key)", () => {
    const { store, calls } = fakeStore();
    applyIntakePlan(plan("auto_apply", { action: "create", title: "T", body: "B", tags: [] }), {
      store,
      submissionText: "x",
      actorId: "system-consolidator",
      underEvaluation: true,
      addendumVersion: null,
    });
    const note = calls.create[0]?.options?.curator_note as Record<string, unknown>;
    expect(note).not.toHaveProperty("addendum_version");
    expect(note).toMatchObject({ proposed_action: "create" }); // still force-proposed
  });

  it("accepted (default, underEvaluation absent) is byte-identical: auto_apply still applies", () => {
    const { store, calls } = fakeStore();
    // No underEvaluation flag → the accepted path.
    const created = applyIntakePlan(
      plan("auto_apply", { action: "create", title: "Anna", body: "Lives in Paris.", tags: [] }),
      deps(store),
    );
    expect(created).toMatchObject({ kind: "created" });
    const note = calls.create[0]?.options?.curator_note as Record<string, unknown>;
    expect(note).not.toHaveProperty("addendum_version"); // never tagged on the accepted path

    // ...and auto_apply archive still archives.
    const a = fakeStore({ mem_old: { title: "Old", body: "Stale." } });
    expect(
      applyIntakePlan(
        plan("auto_apply", { action: "archive", target_id: "mem_old" }),
        deps(a.store),
      ),
    ).toEqual({ kind: "archived", id: "mem_old" });
    expect(a.calls.archive).toEqual(["mem_old"]);
  });
});
