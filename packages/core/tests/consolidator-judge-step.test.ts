// Consolidator judge step (plan 036 Phase 4 / spec 035 §F5). The LLM half of
// the judge: build the prompt from the navigate evidence, call the (injected)
// LLM, parse + route its judgment into a plan. Pairs with the pure judge layer
// (schema/parse/route, already tested). Uses a fake LlmClient — no network.

import {
  type ConsolidationCandidates,
  type LlmClient,
  type Memory,
  buildConsolidatorPrompt,
  judgeSubmission,
} from "@librarian/core";
import { describe, expect, it } from "vitest";

function mem(over: Partial<Memory> & { id: string }): Memory {
  return {
    agent_id: "agent-a",
    title: `title ${over.id}`,
    body: "body",
    status: "active",
    project_key: null,
    priority: "normal",
    confidence: "working",
    tags: [],
    applies_to: [],
    supersedes: [],
    conflicts_with: [],
    recall_count: 0,
    usefulness_score: 0,
    is_global: false,
    requires_approval: false,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

const evidence: ConsolidationCandidates = {
  candidates: [mem({ id: "mem_anna", title: "Anna", body: "Anna lives in Paris." })],
  toc: [{ id: "mem_anna", title: "Anna", tags: ["person"], projectKey: null }],
};

function fakeClient(content: string): LlmClient {
  return {
    complete: async () => ({ content, model: "gpt-x", usage: null }),
  };
}

describe("buildConsolidatorPrompt", () => {
  it("frames a system contract + the untrusted submission and evidence", () => {
    const messages = buildConsolidatorPrompt({
      submissionText: "Anna moved to Berlin",
      evidence,
    });
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toMatch(/consolidat/i);
    // The output contract names every judge action (incl. split, spec 043 D-B).
    for (const action of ["create", "augment", "supersede", "archive", "noop", "split"]) {
      expect(messages[0]!.content).toContain(action);
    }
    // Wikilink + minimal-edit guidance is present.
    expect(messages[0]!.content).toContain("[[");
    const user = messages[1]!.content;
    expect(user).toContain("Anna moved to Berlin");
    expect(user).toContain("mem_anna"); // candidate id is available to reference
    expect(user.toLowerCase()).toContain("untrusted");
  });

  it("instructs the v3 curation ways of working (preserve / calibrate / cautious / retrieval / title-craft / discard-transient)", () => {
    const system = buildConsolidatorPrompt({ submissionText: "x", evidence })[0]!.content;
    const lower = system.toLowerCase();
    expect(lower).toContain("preserve"); // preserve, don't destroy
    expect(lower).toContain("score low"); // calibrate confidence on ambiguity
    expect(lower).toContain("cautiously"); // resolve entities cautiously
    expect(lower).toContain("retrieval"); // file for retrieval, not just storage
    expect(lower).toContain("also its filename"); // v3: title-craft (title == filename)
    expect(lower).toContain("transient or low-value"); // v3: discard obvious noise
  });

  it("redacts secrets from every untrusted field before sending (submission, candidate title+body, toc title+tags, addendum)", () => {
    // redactSecrets catches the `<keyword> = "value"` assignment shape. Assemble
    // those strings at RUNTIME from a bare keyword + a low-entropy fake value, so
    // no literal secret-assignment sits in the committed source (GitGuardian
    // scans source; redactSecrets scans the runtime string). Each field proves
    // redaction is applied there — the tag case guards the fix that tags reach
    // the provider redacted, not raw.
    const assign = (keyword: string, label: string): string => `${keyword} = "fake-${label}"`;
    const messages = buildConsolidatorPrompt({
      submissionText: assign("token", "submission"),
      evidence: {
        candidates: [
          mem({
            id: "m",
            title: assign("api_key", "cand-title"),
            body: assign("secret", "cand-body"),
          }),
        ],
        toc: [
          {
            id: "m",
            title: assign("password", "toc-title"),
            tags: [assign("auth_token", "toc-tag")],
            projectKey: null,
          },
        ],
      },
      promptAddendum: assign("credentials", "addendum"),
    });
    const user = messages[1]!.content;
    for (const label of [
      "submission",
      "cand-title",
      "cand-body",
      "toc-title",
      "toc-tag",
      "addendum",
    ]) {
      expect(user).not.toContain(`fake-${label}`);
    }
    expect(user).toContain("[REDACTED:secret]");
  });

  it("pins the NARROW split guidance: only to un-overload an existing candidate, never over-fragment (spec 043 D-B)", () => {
    const system = buildConsolidatorPrompt({ submissionText: "x", evidence })[0]!.content;
    const lower = system.toLowerCase();
    // Split is offered as a (rare) action…
    expect(lower).toContain("split");
    // …scoped to un-overloading an EXISTING candidate doc (target ∈ candidates)…
    expect(lower).toContain("overloaded");
    expect(lower).toContain('"target_id" must be one of the candidate');
    // …and the anti-over-fragmentation guard is explicit (a single-entity /
    // non-overloaded submission must never split — cf. spec 039).
    expect(lower).toContain("do not split a single-entity");
    // …and it is always a human proposal, never silently applied.
    expect(lower).toContain("always proposed");
  });

  it("routes a model-emitted split to a PROPOSAL even at high confidence (never auto-applies)", async () => {
    const client = fakeClient(
      JSON.stringify({
        action: "split",
        target_id: "mem_anna",
        replacements: [
          { title: "Anna — Person", body: "Anna lives in Paris." },
          { title: "Anna — Cafe", body: "The Anna cafe on Rue X." },
        ],
        rationale: "the doc conflates the person and the cafe",
        confidence: 0.99,
      }),
    );
    const result = await judgeSubmission(
      { submissionText: "The Anna cafe reopened.", evidence },
      { llmClient: client },
    );
    expect(result.parseError).toBeUndefined();
    expect(result.plan?.decision).toBe("propose"); // never auto_apply, even at 0.99
    expect(result.plan?.judgment).toMatchObject({ action: "split", target_id: "mem_anna" });
  });

  it("includes operator guidance as advisory-only when provided", () => {
    const messages = buildConsolidatorPrompt({
      submissionText: "x",
      evidence,
      promptAddendum: "prefer the lessons folder",
    });
    expect(messages[1]!.content).toContain("prefer the lessons folder");
    expect(messages[1]!.content.toLowerCase()).toContain("advisory");
  });
});

describe("judgeSubmission", () => {
  it("routes a high-confidence augment to auto_apply", async () => {
    const client = fakeClient(
      JSON.stringify({
        action: "augment",
        target_id: "mem_anna",
        addition: "She now lives in [[Berlin]].",
        rationale: "adds the move",
        confidence: 0.97,
      }),
    );
    const result = await judgeSubmission(
      { submissionText: "Anna moved to Berlin", evidence },
      { llmClient: client },
    );
    expect(result.parseError).toBeUndefined();
    expect(result.plan?.decision).toBe("auto_apply");
    expect(result.plan?.judgment).toMatchObject({ action: "augment", target_id: "mem_anna" });
  });

  it("surfaces a parse error (and no plan) when the model returns garbage", async () => {
    const result = await judgeSubmission(
      { submissionText: "x", evidence },
      { llmClient: fakeClient("not json at all") },
    );
    expect(result.plan).toBeUndefined();
    expect(result.parseError).toBeTruthy();
  });

  it("threads custom thresholds into the routing", async () => {
    const client = fakeClient(
      JSON.stringify({
        action: "augment",
        target_id: "mem_anna",
        addition: "more",
        rationale: "r",
        confidence: 0.82,
      }),
    );
    // With a lowered auto-apply bar, 0.82 clears it.
    const result = await judgeSubmission(
      { submissionText: "x", evidence },
      { llmClient: client, thresholds: { autoApply: 0.8, propose: 0.6 } },
    );
    expect(result.plan?.decision).toBe("auto_apply");
  });
});
