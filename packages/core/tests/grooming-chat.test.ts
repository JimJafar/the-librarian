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
    title: "Elaine — Piano Teacher",
    body: "Elaine teaches piano on Tuesdays.",
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
    expect(system).toContain("Elaine — Piano Teacher");
    expect(system).toContain("Elaine teaches piano on Tuesdays.");
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

  // Proposal-review rework F5 (D4): a proposal-grounded chat carries the OPEN
  // PROPOSAL context — the judge's persisted plan + the resolved guessed
  // target — so the admin can redirect the filing in conversation.
  it("buildGroundedMessages includes the proposal plan + resolved guessed target when present", () => {
    const messages = buildGroundedMessages({
      grounding: {
        ...memoryGrounding,
        proposal: {
          proposed_action: "augment",
          rationale: "extends the Elaine doc",
          plan: {
            guessed_target_id: "mem_elaine",
            planned_addition: "Now works at [[Acme]].",
            planned_title: null,
            planned_body: null,
            planned_tags: null,
            confidence: 0.7,
          },
          guessed_target: {
            id: "mem_elaine",
            title: "Elaine",
            body: "Lives in Paris.",
            status: "active",
          },
        },
      },
      messages: [{ role: "user", content: "should this really augment Elaine?" }],
    });
    const system = messages[0]?.content ?? "";
    expect(system).toContain("OPEN PROPOSAL");
    expect(system).toContain("Now works at [[Acme]].");
    expect(system).toContain("Lives in Paris."); // the resolved guessed target's body
    expect(system).toContain("0.7");
  });

  it("buildGroundedMessages emits no proposal section for a plain memory grounding", () => {
    const messages = buildGroundedMessages({
      grounding: memoryGrounding,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(messages[0]?.content ?? "").not.toContain("OPEN PROPOSAL");
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
          replacement: { title: "Elaine", body: "merged" },
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

  // Corpus search (proposal-review follow-up): the model may ask for a recall
  // search mid-turn. Internal only — runChatTurn resolves every search before
  // returning, so `search` never reaches the dashboard wire.
  it("parses a search request", () => {
    const r = parseChatOutput(JSON.stringify({ kind: "search", query: "Librarian project" }));
    expect(r).toEqual({ kind: "search", query: "Librarian project" });
  });

  it("FAILS SOFT to a message on a search with no usable query", () => {
    expect(parseChatOutput(JSON.stringify({ kind: "search" })).kind).toBe("message");
    expect(parseChatOutput(JSON.stringify({ kind: "search", query: "  " })).kind).toBe("message");
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
    expect(sent[0]?.content).toContain("Elaine — Piano Teacher");
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
          replacement: { title: "Elaine", body: "merged" },
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

// ── corpus search loop ──────────────────────────────────────────────────────
//
// "Find other memories relating to the Librarian and merge them" needs the
// chat to SEE the corpus. The model asks with { kind: "search", query };
// runChatTurn runs the injected recall, feeds the results back (redacted,
// untrusted-framed), and loops — bounded — until the model answers. The
// search never escapes: runChatTurn always returns a wire ChatResponse.
describe("curator chat — corpus search loop", () => {
  const searchThenMerge = [
    JSON.stringify({ kind: "search", query: "Librarian project" }),
    JSON.stringify({
      kind: "proposed_action",
      action: {
        type: "merge",
        source_ids: ["mem-lib-1", "mem-lib-2"],
        replacement: { title: "The Librarian", body: "merged doc" },
      },
    }),
  ];

  const hits = [
    {
      id: "mem-lib-1",
      title: "Librarian deploy notes",
      body: "deploys via docker",
      status: "active",
    },
    {
      id: "mem-lib-2",
      title: "Librarian backlog",
      body: "vault picker, hybrid ranking",
      status: "active",
    },
  ];

  it("runs the requested search and feeds the results back for the next completion", async () => {
    const { client, requests } = scriptedClient(searchThenMerge);
    const queries: string[] = [];
    const result = await runChatTurn({
      client,
      grounding: memoryGrounding,
      messages: [{ role: "user", content: "merge everything about the Librarian" }],
      searchMemories: async (query) => {
        queries.push(query);
        return hits;
      },
    });

    expect(queries).toEqual(["Librarian project"]);
    // The final response is the merge built from the searched ids.
    expect(result.kind).toBe("proposed_action");
    if (result.kind === "proposed_action" && result.action.type === "merge") {
      expect(result.action.source_ids).toEqual(["mem-lib-1", "mem-lib-2"]);
    }
    // The second completion saw the results: ids + titles, framed untrusted.
    const second = requests[1]!.messages.map((m) => m.content).join("\n");
    expect(second).toContain("SEARCH RESULTS");
    expect(second).toContain("mem-lib-1");
    expect(second).toContain("Librarian deploy notes");
    expect(second.toLowerCase()).toContain("untrusted");
  });

  it("redacts secret-shaped content in search results before the provider sees them", async () => {
    const { client, requests } = scriptedClient(searchThenMerge);
    const secretish = `${"api_key"} = "fake-search-secret"`;
    await runChatTurn({
      client,
      messages: [{ role: "user", content: "find it" }],
      searchMemories: async () => [
        { id: "mem-x", title: "creds", body: secretish, status: "active" },
      ],
    });
    const second = requests[1]!.messages.map((m) => m.content).join("\n");
    expect(second).not.toContain("fake-search-secret");
  });

  it("bounds the loop: a model that only ever searches gets cut off with a message", async () => {
    const alwaysSearch = JSON.stringify({ kind: "search", query: "again" });
    const { client } = scriptedClient([alwaysSearch, alwaysSearch, alwaysSearch, alwaysSearch]);
    let calls = 0;
    const result = await runChatTurn({
      client,
      messages: [{ role: "user", content: "loop forever" }],
      searchMemories: async () => {
        calls++;
        return hits;
      },
    });
    // The budget is 3 searches; the final still-searching reply degrades to prose.
    expect(calls).toBe(3);
    expect(result.kind).toBe("message");
  });

  it("degrades gracefully when no search capability is injected", async () => {
    const { client, requests } = scriptedClient([
      JSON.stringify({ kind: "search", query: "anything" }),
      JSON.stringify({ kind: "message", text: "Working from the grounding alone." }),
    ]);
    const result = await runChatTurn({
      client,
      messages: [{ role: "user", content: "search please" }],
    });
    expect(result).toEqual({ kind: "message", text: "Working from the grounding alone." });
    const second = requests[1]!.messages.map((m) => m.content).join("\n");
    expect(second.toLowerCase()).toContain("unavailable");
  });

  it("a failing search backend degrades to empty results, never a throw", async () => {
    const { client, requests } = scriptedClient([
      JSON.stringify({ kind: "search", query: "boom" }),
      JSON.stringify({ kind: "message", text: "No luck searching." }),
    ]);
    const result = await runChatTurn({
      client,
      messages: [{ role: "user", content: "search" }],
      searchMemories: async () => {
        throw new Error("index offline");
      },
    });
    expect(result.kind).toBe("message");
    const second = requests[1]!.messages.map((m) => m.content).join("\n");
    expect(second.toLowerCase()).toContain("failed");
  });

  it("teaches the search shape in the system contract", () => {
    const messages = buildGroundedMessages({ messages: [{ role: "user", content: "hi" }] });
    const system = messages[0]!.content;
    expect(system).toContain('"kind": "search"');
    expect(system).toMatch(/SEARCH RESULTS/);
  });
});
