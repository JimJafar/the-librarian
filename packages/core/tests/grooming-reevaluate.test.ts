// Re-evaluate grooming proposals (spec 044 D-3 / Task D3c). The batch escape hatch
// that discards the proposals tagged with the current eval version and re-runs
// grooming over their slices under the CURRENT addendum, producing a fresh batch.
//
// Network-free: a scripted LLM client makes the re-judge deterministic plumbing.
// Verifies: only the tagged version's proposals are touched (a DIFFERENT version's
// proposal + active memories are untouched); a fresh batch replaces the stale one
// (no stale duplicate); no eval version / none tagged → clean no-op; grooming not
// runnable → fail-soft (nothing discarded); partial failure on one slice doesn't
// wedge the rest.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  type LlmClient,
  type Memory,
  addProvider,
  createLibrarianStore,
  reEvaluateGroomingProposals,
  resolveSecretKey,
  setAddendumStatus,
  setJobAddendum,
  writeConsumerConfig,
  writeGroomingConfig,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Assemble the 64-hex key at runtime — no secret-shaped literal in source (GitGuardian).
const KEY = resolveSecretKey("0123456789abcdef".repeat(4));

let store: LibrarianStore | null = null;
let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-reeval-"));
  store = createLibrarianStore({ dataDir, secretKey: KEY });
});
afterEach(() => {
  try {
    store?.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  store = null;
});

// An LLM client that emits a single high-confidence create (would auto-apply when
// accepted; force-proposed while under_evaluation). `title` makes each run's
// proposal findable.
function createEmittingClient(title: string, body = "a durable lesson"): LlmClient {
  return {
    complete: async () => ({
      content: JSON.stringify({
        operations: [
          {
            type: "create",
            memory: {
              title,
              body,
              category: "lessons",
              visibility: "common",
              scope: "project",
              project_key: "proj-x",
            },
            rationale: "novel durable lesson",
            confidence: 0.99,
          },
        ],
      }),
      model: "m",
      usage: null,
    }),
  };
}

const noOpClient: LlmClient = {
  complete: async () => ({ content: JSON.stringify({ operations: [] }), model: "m", usage: null }),
};

function seedActive(title: string, projectKey = "proj-x") {
  store!.createMemory({
    agent_id: "agent-a",
    title,
    body: "b",
    category: "lessons",
    visibility: "common",
    scope: "project",
    project_key: projectKey,
    priority: "normal",
    confidence: "working",
  });
}

function configureGrooming(opts: { token?: string } = {}) {
  const provider = addProvider(store!, {
    name: "default",
    endpoint: "https://api.example.com/v1",
    ...(opts.token !== undefined ? { token: opts.token } : {}),
  });
  writeConsumerConfig(store!, "grooming", { providerId: provider.id, model: "gpt-x" });
}

// Put grooming under evaluation against a freshly-committed addendum and return the
// pinned eval version (git hash).
function beginEvaluation(addendum: string): string {
  setJobAddendum(store!, "grooming", addendum);
  setAddendumStatus(store!, "grooming", "under_evaluation");
  const version = store!.readAddendum("grooming").version;
  if (!version) throw new Error("expected an eval version");
  return version;
}

// Exact title lookup (searchMemories is fuzzy keyword matching — too loose to assert
// precise presence/absence of a specific titled memory).
function byTitle(title: string, status: string): Memory[] {
  return store!.listAll({ status }).filter((m) => m.title === title);
}

describe("reEvaluateGroomingProposals — clean no-ops", () => {
  it("returns { reEvaluated: true, count: 0 } when no addendum is under evaluation", async () => {
    seedActive("Active fact");
    writeGroomingConfig(store!, { enabled: true });
    configureGrooming({ token: "dummy-decrypted-token" });

    const result = await reEvaluateGroomingProposals({
      store: store!,
      buildClient: () => noOpClient,
    });
    expect(result).toEqual({ reEvaluated: true, count: 0 });
  });

  it("returns count 0 when under evaluation but nothing is tagged with the version", async () => {
    seedActive("Active fact");
    writeGroomingConfig(store!, { enabled: true });
    configureGrooming({ token: "dummy-decrypted-token" });
    beginEvaluation("fresh guidance"); // version pinned, but no tagged proposals exist

    const result = await reEvaluateGroomingProposals({
      store: store!,
      buildClient: () => noOpClient,
    });
    expect(result).toEqual({ reEvaluated: true, count: 0 });
  });
});

describe("reEvaluateGroomingProposals — fail-soft gating", () => {
  it("does not discard the stale batch when grooming is disabled", async () => {
    seedActive("Active fact");
    writeGroomingConfig(store!, { enabled: true });
    configureGrooming({ token: "dummy-decrypted-token" });
    const version = beginEvaluation("v1 guidance");
    // Hand-seed a tagged proposal (as a grooming run under eval would).
    store!.createMemory(
      {
        agent_id: "agent-a",
        title: "Stale proposal",
        body: "stale",
        category: "lessons",
        visibility: "common",
        scope: "project",
        project_key: "proj-x",
      },
      { requires_approval: true, curator_note: { addendum_version: version } },
    );
    // Now DISABLE grooming.
    writeGroomingConfig(store!, { enabled: false });

    const result = await reEvaluateGroomingProposals({
      store: store!,
      buildClient: () => noOpClient,
    });
    expect(result).toEqual({ reEvaluated: false, reason: "disabled" });
    // The stale proposal is STILL there — nothing was discarded.
    expect(byTitle("Stale proposal", "proposed").length).toBe(1);
  });

  it("does not discard the stale batch when the token can't be decrypted", async () => {
    seedActive("Active fact");
    writeGroomingConfig(store!, { enabled: true });
    configureGrooming({ token: "dummy-secret" });
    const version = beginEvaluation("v1 guidance");
    store!.createMemory(
      {
        agent_id: "agent-a",
        title: "Stale proposal",
        body: "stale",
        category: "lessons",
        visibility: "common",
        scope: "project",
        project_key: "proj-x",
      },
      { requires_approval: true, curator_note: { addendum_version: version } },
    );
    store!.close();
    // Reopen WITHOUT the master key → the token can't be decrypted.
    store = createLibrarianStore({ dataDir });

    const result = await reEvaluateGroomingProposals({
      store: store!,
      buildClient: () => noOpClient,
    });
    expect(result).toEqual({ reEvaluated: false, reason: "no_token" });
    expect(byTitle("Stale proposal", "proposed").length).toBe(1);
  });
});

describe("reEvaluateGroomingProposals — re-judges only the tagged version", () => {
  it("discards the tagged batch and produces a fresh re-tagged batch (no stale duplicate)", async () => {
    seedActive("Active fact");
    writeGroomingConfig(store!, { enabled: true, defaultAutoApply: "high_confidence" });
    configureGrooming({ token: "dummy-decrypted-token" });
    const version = beginEvaluation("v1 guidance");
    // Seed a stale tagged proposal in the proj-x slice.
    store!.createMemory(
      {
        agent_id: "agent-a",
        title: "Stale curator proposal",
        body: "stale body",
        category: "lessons",
        visibility: "common",
        scope: "project",
        project_key: "proj-x",
      },
      { requires_approval: true, curator_note: { addendum_version: version } },
    );

    // Re-evaluate: the re-run emits a FRESH create.
    const result = await reEvaluateGroomingProposals({
      store: store!,
      buildClient: () => createEmittingClient("Fresh curator proposal"),
    });
    expect(result).toEqual({ reEvaluated: true, count: 1 });

    // The stale proposal is gone (archived — discarded).
    expect(byTitle("Stale curator proposal", "proposed")).toEqual([]);
    // A fresh proposal exists, re-tagged with the (still-current) eval version.
    const fresh = byTitle("Fresh curator proposal", "proposed");
    expect(fresh.length).toBe(1);
    expect(fresh[0]?.curator_note?.addendum_version).toBe(version);
    // Nothing was auto-applied to active (under evaluation forces propose).
    expect(byTitle("Fresh curator proposal", "active")).toEqual([]);
  });

  it("leaves proposals tagged with a DIFFERENT version untouched", async () => {
    seedActive("Active fact");
    writeGroomingConfig(store!, { enabled: true, defaultAutoApply: "high_confidence" });
    configureGrooming({ token: "dummy-decrypted-token" });
    const version = beginEvaluation("v2 guidance");
    // A proposal tagged with the CURRENT version (will be discarded + refreshed).
    store!.createMemory(
      {
        agent_id: "agent-a",
        title: "Current version proposal",
        body: "x",
        category: "lessons",
        visibility: "common",
        scope: "project",
        project_key: "proj-x",
      },
      { requires_approval: true, curator_note: { addendum_version: version } },
    );
    // A proposal tagged with a DIFFERENT (older) version — must NOT be touched.
    store!.createMemory(
      {
        agent_id: "agent-a",
        title: "Old version proposal",
        body: "y",
        category: "lessons",
        visibility: "common",
        scope: "project",
        project_key: "proj-x",
      },
      { requires_approval: true, curator_note: { addendum_version: "deadbeefdeadbeef" } },
    );

    const result = await reEvaluateGroomingProposals({
      store: store!,
      buildClient: () => createEmittingClient("Fresh version proposal"),
    });
    expect(result).toEqual({ reEvaluated: true, count: 1 });

    // The different-version proposal survived untouched (still proposed).
    const other = byTitle("Old version proposal", "proposed");
    expect(other.length).toBe(1);
    expect(other[0]?.curator_note?.addendum_version).toBe("deadbeefdeadbeef");
    // The current-version proposal was discarded (refreshed).
    expect(byTitle("Current version proposal", "proposed")).toEqual([]);
    // The active corpus is untouched (still active, not archived).
    expect(byTitle("Active fact", "active").length).toBe(1);
  });
});

describe("reEvaluateGroomingProposals — partial-failure fail-soft", () => {
  it("a re-judge failure on one slice does not wedge the batch or corrupt state", async () => {
    // Two slices: proj-x and proj-y, each with an active memory + a tagged proposal.
    seedActive("Active X", "proj-x");
    seedActive("Active Y", "proj-y");
    writeGroomingConfig(store!, { enabled: true, defaultAutoApply: "high_confidence" });
    configureGrooming({ token: "dummy-decrypted-token" });
    const version = beginEvaluation("v1 guidance");
    for (const pk of ["proj-x", "proj-y"]) {
      store!.createMemory(
        {
          agent_id: "agent-a",
          title: `Stale ${pk}`,
          body: "stale",
          category: "lessons",
          visibility: "common",
          scope: "project",
          project_key: pk,
        },
        { requires_approval: true, curator_note: { addendum_version: version } },
      );
    }

    // A client that THROWS for the proj-y slice (its active memory is "Active Y")
    // but succeeds for proj-x. The worker swallows the per-slice failure.
    const flakyClient: LlmClient = {
      complete: async (request) => {
        const prompt = request.messages.map((m) => m.content).join("\n");
        if (prompt.includes("Active Y")) throw new Error("simulated judge failure");
        return createEmittingClient("Fresh X").complete(request);
      },
    };

    const result = await reEvaluateGroomingProposals({
      store: store!,
      buildClient: () => flakyClient,
    });
    // Still reports the full batch (both stale proposals discarded + attempted).
    expect(result).toEqual({ reEvaluated: true, count: 2 });

    // proj-x refreshed; both stale proposals discarded; no crash.
    expect(byTitle("Fresh X", "proposed").length).toBe(1);
    expect(byTitle("Stale proj-x", "proposed")).toEqual([]);
    expect(byTitle("Stale proj-y", "proposed")).toEqual([]);
    // Active corpus intact in both slices.
    expect(byTitle("Active X", "active").length).toBe(1);
    expect(byTitle("Active Y", "active").length).toBe(1);
  });
});
