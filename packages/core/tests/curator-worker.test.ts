// Curator worker (spec §10 pipeline + §12/§14) — end-to-end over a real store
// with an INJECTED fake LLM client (no network). Pins that a run threads
// gather → prepass → prompt → parse → validate → apply and records its lifecycle.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ApplyPolicy,
  type LibrarianStore,
  type LlmClient,
  type LlmCompletion,
  LlmClientError,
  createLibrarianStore,
  runCuration,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface Scope {
  store: LibrarianStore;
  dataDir: string;
}

let s: Scope | null = null;

beforeEach(() => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-worker-"));
  s = { store: createLibrarianStore({ dataDir }), dataDir };
});
afterEach(() => {
  if (!s) return;
  try {
    s.store.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(s.dataDir, { recursive: true, force: true });
  s = null;
});

function seed(over: Record<string, unknown> = {}) {
  return s!.store.createMemory({
    agent_id: "agent-a",
    title: "title",
    body: "body",
    category: "lessons",
    visibility: "common",
    scope: "project",
    project_key: "proj-x",
    priority: "normal",
    confidence: "working",
    ...over,
  }).memory;
}

/** A fake LLM client returning a canned completion. */
function fakeClient(content: string, usage?: LlmCompletion["usage"]): LlmClient {
  return { complete: async () => ({ content, model: "gpt-x", usage: usage ?? null }) };
}

const SLICE = { kind: "common_project" as const, projectKey: "proj-x" };

function options(llmClient: LlmClient, level: ApplyPolicy["level"] = "safe_only") {
  return {
    store: s!.store,
    llmClient,
    trigger: "manual",
    actorId: "system-memory-curator",
    policy: { level, confidenceThreshold: 0.9 },
    model: { provider: "openai", name: "gpt-x" },
  };
}

describe("runCuration — happy path", () => {
  it("threads the pipeline and auto-applies a safe duplicate archive", async () => {
    const dupA = seed({ title: "Dup", body: "same body" });
    const dupB = seed({ title: "Dup", body: "same body" });
    const client = fakeClient(
      JSON.stringify({
        operations: [
          {
            type: "archive",
            source_memory_ids: [dupB.id],
            rationale: "exact duplicate of the other",
            confidence: 0.95,
          },
        ],
      }),
      { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    );

    const run = await runCuration(SLICE, options(client));

    expect(run.status).toBe("completed");
    expect(s!.store.getMemory(dupB.id)?.status).toBe("archived");
    expect(s!.store.getMemory(dupA.id)?.status).toBe("active"); // only the cited dup
    expect(run.summary).toContain("applied 1");
    expect(run.usage_input_tokens).toBe(100);
    expect(run.usage_output_tokens).toBe(20);
    expect(run.input_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(run.model_name).toBe("gpt-x");

    const recorded = s!.store.getCurationOperations(run.id);
    expect(recorded.some((o) => o.operation_type === "archive" && o.status === "applied")).toBe(
      true,
    );
  });

  it("records schema-rejected operations as skipped without aborting the run", async () => {
    const m = seed();
    const client = fakeClient(
      JSON.stringify({
        operations: [
          { type: "not_a_real_type", source_memory_ids: [m.id], rationale: "x", confidence: 1 },
          { type: "noop", source_memory_ids: [], rationale: "nothing", confidence: 0.5 },
        ],
      }),
    );

    const run = await runCuration(SLICE, options(client));
    expect(run.status).toBe("completed");
    const recorded = s!.store.getCurationOperations(run.id);
    expect(recorded.some((o) => o.status === "skipped" && o.rationale.startsWith("schema:"))).toBe(
      true,
    );
  });
});

describe("runCuration — failure paths leave memory untouched", () => {
  it("fails the run with a value-free label on an LLM error", async () => {
    const m = seed();
    const client: LlmClient = {
      complete: async () => {
        throw new LlmClientError("network", "connection refused to 10.0.0.1");
      },
    };

    const run = await runCuration(SLICE, options(client));
    expect(run.status).toBe("failed");
    expect(run.error).toBe("llm_network"); // value-free, no host/detail
    expect(s!.store.getMemory(m.id)?.status).toBe("active");
  });

  it("fails the run on unparseable output", async () => {
    const m = seed();
    const run = await runCuration(SLICE, options(fakeClient("this is not json at all")));
    expect(run.status).toBe("failed");
    expect(run.error).toBe("parse_error");
    expect(s!.store.getMemory(m.id)?.status).toBe("active");
  });
});
