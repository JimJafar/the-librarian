// Curator chat endpoint — pure core logic (spec 044 D-6b / decisions D-5/6/8/9/10).
//
// `runChatTurn` is the request/response (NO streaming) orchestration the admin
// `curator.chat` tRPC sits on. It:
//   - GROUNDS a turn in a real memory + its decision history (grooming ops via
//     getCurationOperations filtered by source_memory_ids; intake ops via the C1
//     intake decision log) — composed into a SYSTEM message prepended to
//     the caller's messages (decision D-9 infer-then-ask);
//   - INFERS the job from that history when `job` is unset;
//   - returns a discriminated union: prose (`message`), a D5 fix-now mutation the
//     admin will CONFIRM (`proposed_action` — chat NEVER executes it), or an
//     `addendum_edit` candidate;
//   - runs the 2 KB CONDENSE loop (decision D-10): an addendum_edit candidate over
//     2048 bytes triggers ONE condense turn, not a hard error; still-over →
//     returned flagged `over_limit`.
//
// All tests use a SCRIPTED LlmClient (deterministic, no network).

import {
  type ChatMemoryGrounding,
  type ChatResponse,
  type LlmClient,
  type LlmCompletion,
  type LlmCompletionRequest,
  buildGroundedMessages,
  inferChatJob,
  parseChatOutput,
  runChatTurn,
} from "@librarian/core";
import { describe, expect, it } from "vitest";

// A scripted client: returns the queued completions in order, records every
// request it saw (so a test can assert what reached the model).
function scriptedClient(contents: string[]): {
  client: LlmClient;
  requests: LlmCompletionRequest[];
} {
  const requests: LlmCompletionRequest[] = [];
  let i = 0;
  const client: LlmClient = {
    async complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
      requests.push(request);
      const content = contents[i++] ?? "{}";
      return { content, model: "scripted", usage: null };
    },
  };
  return { client, requests };
}

const memoryGrounding: ChatMemoryGrounding = {
  memory: {
    id: "mem-1",
    title: "Anna — Piano Teacher",
    body: "Anna teaches piano on Tuesdays.",
    status: "active",
  },
  groomingOps: [
    {
      operation_type: "update",
      status: "applied",
      rationale: "tightened the title",
      source_memory_ids: ["mem-1"],
      target_memory_ids: ["mem-1"],
    },
  ],
  intakeOps: [
    {
      action: "augment",
      outcome: "applied",
      rationale: "added the Tuesday detail",
      target_id: "mem-1",
    },
  ],
};

describe("curator chat — grounding (decision D-9)", () => {
  it("buildGroundedMessages prepends a SYSTEM message containing the memory + its decision history", () => {
    const messages = buildGroundedMessages({
      grounding: memoryGrounding,
      job: "grooming",
      addendum: "prefer concise lessons",
      messages: [{ role: "user", content: "should this be split?" }],
    });

    expect(messages[0]?.role).toBe("system");
    const system = messages[0]?.content ?? "";
    // The memory content is in the grounding.
    expect(system).toContain("Anna — Piano Teacher");
    expect(system).toContain("Anna teaches piano on Tuesdays.");
    // Its decision history (both grooming + intake ops) is in the grounding.
    expect(system).toContain("tightened the title");
    expect(system).toContain("added the Tuesday detail");
    // The job addendum is included.
    expect(system).toContain("prefer concise lessons");
    // The caller's messages follow the system message verbatim.
    expect(messages.at(-1)).toEqual({ role: "user", content: "should this be split?" });
  });

  it("buildGroundedMessages REDACTS secret-looking material from the grounded prompt", () => {
    const messages = buildGroundedMessages({
      grounding: {
        memory: {
          id: "mem-2",
          title: "API note",
          body: "the key is Bearer sk-supersecretsupersecret12345",
          status: "active",
        },
        groomingOps: [],
        intakeOps: [],
      },
      messages: [{ role: "user", content: "hi" }],
    });
    const system = messages[0]?.content ?? "";
    expect(system).not.toContain("sk-supersecretsupersecret12345");
    expect(system).toContain("[REDACTED");
  });

  it("buildGroundedMessages degrades gracefully with no memory grounding (general chat)", () => {
    const messages = buildGroundedMessages({
      messages: [{ role: "user", content: "let's chat about grooming" }],
    });
    // Still a valid prompt: a system message + the caller's messages, no throw.
    expect(messages[0]?.role).toBe("system");
    expect(messages.at(-1)).toEqual({ role: "user", content: "let's chat about grooming" });
  });
});

describe("curator chat — infer-then-ask job (decision D-9)", () => {
  it("infers grooming when the decision history is dominated by grooming ops", () => {
    expect(
      inferChatJob({
        groomingOps: [
          { operation_type: "merge", status: "applied", source_memory_ids: ["a", "b"] },
          { operation_type: "update", status: "proposed", source_memory_ids: ["a"] },
        ],
        intakeOps: [],
      }),
    ).toBe("grooming");
  });

  it("infers intake when the decision history is dominated by intake ops", () => {
    expect(
      inferChatJob({
        groomingOps: [],
        intakeOps: [
          { action: "augment", outcome: "applied" },
          { action: "create", outcome: "applied" },
        ],
      }),
    ).toBe("intake");
  });

  it("falls back to a sensible default (grooming) when there is no history to infer from", () => {
    expect(inferChatJob({ groomingOps: [], intakeOps: [] })).toBe("grooming");
  });
});

describe("curator chat — output parsing (fail-soft)", () => {
  it("parses plain prose into a message response", () => {
    const r = parseChatOutput(JSON.stringify({ kind: "message", text: "Here's my take." }));
    expect(r).toEqual({ kind: "message", text: "Here's my take." });
  });

  it("parses a proposed merge action into a proposed_action that matches the D5 merge shape", () => {
    const r = parseChatOutput(
      JSON.stringify({
        kind: "proposed_action",
        action: {
          type: "merge",
          source_ids: ["mem-1", "mem-2"],
          replacement: { title: "Anna", body: "merged" },
        },
      }),
    );
    expect(r.kind).toBe("proposed_action");
    if (r.kind === "proposed_action") {
      expect(r.action.type).toBe("merge");
    }
  });

  it("parses a proposed update / split / unmerge action", () => {
    const upd = parseChatOutput(
      JSON.stringify({
        kind: "proposed_action",
        action: { type: "update", id: "mem-1", patch: { title: "New title" } },
      }),
    );
    expect(upd.kind).toBe("proposed_action");

    const split = parseChatOutput(
      JSON.stringify({
        kind: "proposed_action",
        action: {
          type: "split",
          source_id: "mem-1",
          replacements: [
            { title: "A", body: "a" },
            { title: "B", body: "b" },
          ],
        },
      }),
    );
    expect(split.kind).toBe("proposed_action");

    const unmerge = parseChatOutput(
      JSON.stringify({ kind: "proposed_action", action: { type: "unmerge", id: "mem-1" } }),
    );
    expect(unmerge.kind).toBe("proposed_action");
  });

  it("FAILS SOFT to a message when the action does not validate against the D5 schema", () => {
    // A merge with only one source is not a valid D5 merge (≥2 required).
    const r = parseChatOutput(
      JSON.stringify({
        kind: "proposed_action",
        action: { type: "merge", source_ids: ["only-one"], replacement: { title: "x" } },
      }),
    );
    expect(r.kind).toBe("message");
  });

  it("FAILS SOFT to a message when the output is not valid JSON", () => {
    const r = parseChatOutput("not json at all");
    expect(r.kind).toBe("message");
    if (r.kind === "message") expect(r.text.length).toBeGreaterThan(0);
  });

  it("parses an addendum_edit candidate", () => {
    const r = parseChatOutput(
      JSON.stringify({ kind: "addendum_edit", job: "grooming", candidate: "be concise" }),
    );
    expect(r).toMatchObject({ kind: "addendum_edit", job: "grooming", candidate: "be concise" });
  });
});

describe("curator chat — runChatTurn orchestration", () => {
  it("returns a GROUNDED response: the scripted client sees the memory + its decision history", async () => {
    const { client, requests } = scriptedClient([
      JSON.stringify({ kind: "message", text: "I'd leave it as one memory." }),
    ]);
    const result = await runChatTurn({
      client,
      grounding: memoryGrounding,
      job: "grooming",
      addendum: "prefer concise lessons",
      messages: [{ role: "user", content: "should this be split?" }],
    });

    expect(result).toEqual({ kind: "message", text: "I'd leave it as one memory." });
    // The grounded SYSTEM message reached the model.
    const sent = requests[0]?.messages ?? [];
    expect(sent[0]?.role).toBe("system");
    expect(sent[0]?.content).toContain("Anna — Piano Teacher");
    expect(sent[0]?.content).toContain("tightened the title");
    expect(sent[0]?.content).toContain("added the Tuesday detail");
  });

  it("returns a proposed_action a D5 mutation can consume — and runs exactly ONE LLM turn", async () => {
    const { client, requests } = scriptedClient([
      JSON.stringify({
        kind: "proposed_action",
        action: {
          type: "merge",
          source_ids: ["mem-1", "mem-2"],
          replacement: { title: "Anna", body: "merged" },
        },
      }),
    ]);
    const result = await runChatTurn({
      client,
      messages: [{ role: "user", content: "merge these two" }],
    });
    expect(result.kind).toBe("proposed_action");
    expect(requests).toHaveLength(1); // prose/action path is a single turn
  });

  // ── 2 KB condense loop (decision D-10) ──────────────────────────────────────

  it("triggers a CONDENSE turn for an over-2 KB addendum candidate — not a hard error", async () => {
    const over = "x".repeat(2100); // > 2048 bytes
    const under = "shortened guidance"; // ≤ 2048 bytes
    const { client, requests } = scriptedClient([
      JSON.stringify({ kind: "addendum_edit", job: "grooming", candidate: over }),
      JSON.stringify({ kind: "addendum_edit", job: "grooming", candidate: under }),
    ]);
    const result = await runChatTurn({
      client,
      messages: [{ role: "user", content: "draft a grooming addendum" }],
    });

    // Two LLM turns happened (the original + ONE condense turn). No throw.
    expect(requests).toHaveLength(2);
    expect(result.kind).toBe("addendum_edit");
    if (result.kind === "addendum_edit") {
      expect(result.candidate).toBe(under);
      expect(Buffer.byteLength(result.candidate, "utf8")).toBeLessThanOrEqual(2048);
      expect(result.over_limit).toBeFalsy();
    }
  });

  it("flags over_limit (does NOT crash) when the candidate is STILL over 2 KB after condensing", async () => {
    const over1 = "x".repeat(2100);
    const over2 = "y".repeat(2200); // condense turn returned something STILL over the cap
    const { client, requests } = scriptedClient([
      JSON.stringify({ kind: "addendum_edit", job: "grooming", candidate: over1 }),
      JSON.stringify({ kind: "addendum_edit", job: "grooming", candidate: over2 }),
    ]);
    const result = await runChatTurn({
      client,
      messages: [{ role: "user", content: "draft a grooming addendum" }],
    });

    expect(requests).toHaveLength(2); // exactly ONE condense turn, then give up softly
    expect(result.kind).toBe("addendum_edit");
    if (result.kind === "addendum_edit") {
      expect(result.over_limit).toBe(true);
      expect(Buffer.byteLength(result.candidate, "utf8")).toBeGreaterThan(2048);
    }
  });

  it("does NOT condense an addendum candidate already ≤ 2 KB (single turn)", async () => {
    const { client, requests } = scriptedClient([
      JSON.stringify({ kind: "addendum_edit", job: "grooming", candidate: "fine" }),
    ]);
    const result = await runChatTurn({
      client,
      messages: [{ role: "user", content: "draft an addendum" }],
    });
    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({ kind: "addendum_edit", candidate: "fine" });
  });

  it("fails soft to a message when the model returns unparseable output (never throws)", async () => {
    const { client } = scriptedClient(["this is not json"]);
    const result: ChatResponse = await runChatTurn({
      client,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.kind).toBe("message");
  });
});
