// Consolidator judge decision layer (plan 036 Phase 4 / spec 035 §F5: "judge
// (augment/create/supersede/archive), confidence band ≥0.95 auto / 0.85–0.95
// proposal / ≤0.85 new (S12)"). The PURE half: parse the untrusted LLM judgment
// for one submission, then route it by the three confidence bands. The LLM
// prompt + call that produces the raw judgment is a separate increment; here we
// feed hand-written JSON, so no model is needed.

import {
  type ConsolidationJudgment,
  parseConsolidationJudgment,
  routeConsolidation,
} from "@librarian/core";
import { describe, expect, it } from "vitest";

describe("parseConsolidationJudgment", () => {
  it("parses each judge action", () => {
    const create = parseConsolidationJudgment(
      JSON.stringify({
        action: "create",
        title: "Anna",
        body: "Anna moved to Berlin.",
        tags: ["person"],
        rationale: "novel topic",
        confidence: 0.9,
      }),
    );
    expect(create.judgment).toMatchObject({ action: "create", title: "Anna" });
    expect(create.parseError).toBeUndefined();

    expect(
      parseConsolidationJudgment(
        JSON.stringify({
          action: "augment",
          target_id: "mem_1",
          addition: "She now lives in Berlin.",
          rationale: "adds to the Anna doc",
          confidence: 0.97,
        }),
      ).judgment,
    ).toMatchObject({ action: "augment", target_id: "mem_1" });

    expect(
      parseConsolidationJudgment(
        JSON.stringify({
          action: "supersede",
          target_id: "mem_1",
          title: "Anna",
          body: "Anna works at Acme (was: Globex).",
          rationale: "job changed",
          confidence: 0.96,
        }),
      ).judgment,
    ).toMatchObject({ action: "supersede", target_id: "mem_1" });

    expect(
      parseConsolidationJudgment(
        JSON.stringify({
          action: "archive",
          target_id: "mem_2",
          rationale: "stale",
          confidence: 0.99,
        }),
      ).judgment,
    ).toMatchObject({ action: "archive", target_id: "mem_2" });

    expect(
      parseConsolidationJudgment(
        JSON.stringify({ action: "noop", rationale: "duplicate", confidence: 0.5 }),
      ).judgment,
    ).toMatchObject({ action: "noop" });

    expect(
      parseConsolidationJudgment(
        JSON.stringify({
          action: "split",
          target_id: "mem_overloaded",
          replacements: [
            { title: "Anna", body: "About Anna." },
            { title: "Bob", body: "About Bob.", tags: ["person"] },
          ],
          rationale: "two distinct entities in one doc",
          confidence: 0.9,
        }),
      ).judgment,
    ).toMatchObject({ action: "split", target_id: "mem_overloaded" });
  });

  it("rejects a split with fewer than 2 replacements (anti-over-fragmentation)", () => {
    const parsed = parseConsolidationJudgment(
      JSON.stringify({
        action: "split",
        target_id: "mem_1",
        replacements: [{ title: "Only one", body: "x" }],
        rationale: "y",
        confidence: 0.9,
      }),
    );
    expect(parsed.judgment).toBeUndefined();
    expect(parsed.parseError).toBeTruthy();
  });

  it("tolerates a markdown code fence", () => {
    const raw = '```json\n{"action":"noop","rationale":"x","confidence":0.5}\n```';
    expect(parseConsolidationJudgment(raw).judgment).toMatchObject({ action: "noop" });
  });

  it("reports a parse error for non-JSON", () => {
    const parsed = parseConsolidationJudgment("not json");
    expect(parsed.judgment).toBeUndefined();
    expect(parsed.parseError).toBeTruthy();
  });

  it("rejects an unknown action", () => {
    const parsed = parseConsolidationJudgment(
      JSON.stringify({ action: "delete_everything", rationale: "x", confidence: 1 }),
    );
    expect(parsed.judgment).toBeUndefined();
    expect(parsed.parseError).toBeTruthy();
  });

  it("rejects a judgment missing required fields", () => {
    // augment without a target_id
    const parsed = parseConsolidationJudgment(
      JSON.stringify({ action: "augment", addition: "x", rationale: "y", confidence: 0.9 }),
    );
    expect(parsed.judgment).toBeUndefined();
    expect(parsed.parseError).toBeTruthy();
  });

  it("rejects an out-of-range confidence", () => {
    const parsed = parseConsolidationJudgment(
      JSON.stringify({ action: "noop", rationale: "x", confidence: 1.5 }),
    );
    expect(parsed.judgment).toBeUndefined();
  });

  it("rejects unexpected fields (strict — no smuggling)", () => {
    const parsed = parseConsolidationJudgment(
      JSON.stringify({
        action: "noop",
        rationale: "x",
        confidence: 0.5,
        curator_note: "forged",
      }),
    );
    expect(parsed.judgment).toBeUndefined();
  });
});

describe("routeConsolidation — three-band confidence policy (S12)", () => {
  const judge = (
    over: Partial<ConsolidationJudgment> & { action: string },
  ): ConsolidationJudgment =>
    ({ rationale: "r", confidence: 0.9, ...over }) as ConsolidationJudgment;

  it("a noop is skipped", () => {
    expect(routeConsolidation(judge({ action: "noop" })).decision).toBe("skip");
  });

  it("a create always auto-applies (a fresh doc risks nothing existing)", () => {
    expect(
      routeConsolidation(judge({ action: "create", title: "t", body: "b", confidence: 0.2 }))
        .decision,
    ).toBe("auto_apply");
  });

  it("augment: ≥0.95 auto-applies, 0.85–0.95 proposes, <0.85 creates a new doc (S12)", () => {
    const augment = (c: number) =>
      routeConsolidation(judge({ action: "augment", target_id: "m", addition: "a", confidence: c }))
        .decision;
    expect(augment(0.97)).toBe("auto_apply");
    expect(augment(0.95)).toBe("auto_apply"); // boundary → upper band
    expect(augment(0.9)).toBe("propose");
    expect(augment(0.85)).toBe("propose"); // boundary → middle band
    expect(augment(0.84)).toBe("create_new"); // uncertain merge → new doc, not a wrong merge
  });

  it("supersede auto-applies only when very confident, else proposes (never silently replaces)", () => {
    const sup = (c: number) =>
      routeConsolidation(
        judge({ action: "supersede", target_id: "m", title: "t", body: "b", confidence: c }),
      ).decision;
    expect(sup(0.96)).toBe("auto_apply");
    expect(sup(0.9)).toBe("propose");
    expect(sup(0.5)).toBe("propose");
  });

  it("archive auto-applies only when very confident, else proposes (never silently removes)", () => {
    const arch = (c: number) =>
      routeConsolidation(judge({ action: "archive", target_id: "m", confidence: c })).decision;
    expect(arch(0.99)).toBe("auto_apply");
    expect(arch(0.94)).toBe("propose");
  });

  it("a split ALWAYS proposes — never auto-applies, even at confidence 1.0 (spec 043 D-B)", () => {
    const split = (c: number) =>
      routeConsolidation(
        judge({
          action: "split",
          target_id: "m",
          replacements: [
            { title: "A", body: "a" },
            { title: "B", body: "b" },
          ],
          confidence: c,
        }),
      ).decision;
    expect(split(1)).toBe("propose"); // the load-bearing guarantee: no auto-apply
    expect(split(0.99)).toBe("propose");
    expect(split(0.5)).toBe("propose");
  });

  it("carries the judgment through on the plan", () => {
    const j = judge({ action: "archive", target_id: "m", confidence: 0.99 });
    expect(routeConsolidation(j).judgment).toBe(j);
  });

  it("honours custom thresholds", () => {
    const j = judge({ action: "augment", target_id: "m", addition: "a", confidence: 0.7 });
    expect(routeConsolidation(j, { autoApply: 0.8, propose: 0.6 }).decision).toBe("propose");
  });
});
