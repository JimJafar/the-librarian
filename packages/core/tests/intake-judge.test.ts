// Intake judge parsing layer (plan 036 Phase 4 / spec 035 §F5). The PURE half:
// parse the untrusted LLM judgment for one submission. The routing half (the
// old three-band policy) died with rethink D13 — the apply layer's verdicts
// are pinned by curator-apply-policy.test.ts + intake-apply.test.ts. The LLM
// prompt + call that produces the raw judgment is a separate increment; here we
// feed hand-written JSON, so no model is needed.

import { parseIntakeJudgment } from "@librarian/core";
import { describe, expect, it } from "vitest";

describe("parseIntakeJudgment", () => {
  it("parses each judge action", () => {
    const create = parseIntakeJudgment(
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
      parseIntakeJudgment(
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
      parseIntakeJudgment(
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
      parseIntakeJudgment(
        JSON.stringify({
          action: "archive",
          target_id: "mem_2",
          rationale: "stale",
          confidence: 0.99,
        }),
      ).judgment,
    ).toMatchObject({ action: "archive", target_id: "mem_2" });

    expect(
      parseIntakeJudgment(
        JSON.stringify({ action: "noop", rationale: "duplicate", confidence: 0.5 }),
      ).judgment,
    ).toMatchObject({ action: "noop" });

    expect(
      parseIntakeJudgment(
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
    const parsed = parseIntakeJudgment(
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
    expect(parseIntakeJudgment(raw).judgment).toMatchObject({ action: "noop" });
  });

  it("reports a parse error for non-JSON", () => {
    const parsed = parseIntakeJudgment("not json");
    expect(parsed.judgment).toBeUndefined();
    expect(parsed.parseError).toBeTruthy();
  });

  it("rejects an unknown action", () => {
    const parsed = parseIntakeJudgment(
      JSON.stringify({ action: "delete_everything", rationale: "x", confidence: 1 }),
    );
    expect(parsed.judgment).toBeUndefined();
    expect(parsed.parseError).toBeTruthy();
  });

  it("rejects a judgment missing required fields", () => {
    // augment without a target_id
    const parsed = parseIntakeJudgment(
      JSON.stringify({ action: "augment", addition: "x", rationale: "y", confidence: 0.9 }),
    );
    expect(parsed.judgment).toBeUndefined();
    expect(parsed.parseError).toBeTruthy();
  });

  it("rejects an out-of-range confidence", () => {
    const parsed = parseIntakeJudgment(
      JSON.stringify({ action: "noop", rationale: "x", confidence: 1.5 }),
    );
    expect(parsed.judgment).toBeUndefined();
  });

  it("rejects unexpected fields (strict — no smuggling)", () => {
    const parsed = parseIntakeJudgment(
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
