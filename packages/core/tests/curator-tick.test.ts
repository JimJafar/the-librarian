// Curator tick (spec §12/§14) — the config-driven entrypoint. Verifies gating
// (disabled / incomplete / undecryptable token) and that an operational config
// builds the client from the GROOMING consumer's provider+model (042 2A) and runs
// due slices. Network-free via an injected client builder.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  type LlmClient,
  type LlmCompletionRequest,
  addProvider,
  createLibrarianStore,
  resolveSecretKey,
  runCuratorTick,
  setAddendumStatus,
  setJobAddendum,
  writeConsumerConfig,
  writeCuratorConfig,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Assemble the 64-hex key at runtime — no secret-shaped literal in source (GitGuardian).
const KEY = resolveSecretKey("0123456789abcdef".repeat(4));

let store: LibrarianStore | null = null;
let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-tick-"));
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

const noOpClient: LlmClient = {
  complete: async () => ({ content: JSON.stringify({ operations: [] }), model: "m", usage: null }),
};

function seedMemory() {
  store!.createMemory({
    agent_id: "agent-a",
    title: "t",
    body: "b",
    category: "lessons",
    visibility: "common",
    scope: "project",
    project_key: "proj-x",
    priority: "normal",
    confidence: "working",
  });
}

// Point the grooming consumer at a provider (optionally with a token).
function configureGrooming(opts: { token?: string } = {}) {
  const provider = addProvider(store!, {
    name: "default",
    endpoint: "https://api.example.com/v1",
    ...(opts.token !== undefined ? { token: opts.token } : {}),
  });
  writeConsumerConfig(store!, "grooming", { providerId: provider.id, model: "gpt-x" });
}

describe("runCuratorTick — gating", () => {
  it("does nothing when curation is disabled (the default)", async () => {
    const result = await runCuratorTick({ store: store! });
    expect(result).toEqual({ ran: false, reason: "disabled" });
  });

  it("does nothing when the grooming LLM config is incomplete (no token)", async () => {
    writeCuratorConfig(store!, { enabled: true });
    configureGrooming(); // provider has no token
    const result = await runCuratorTick({ store: store! });
    expect(result).toEqual({ ran: false, reason: "incomplete_config" });
  });
});

describe("runCuratorTick — operational", () => {
  it("builds the client from the grooming consumer (with the decrypted token) and runs due slices", async () => {
    seedMemory();
    writeCuratorConfig(store!, { enabled: true });
    configureGrooming({ token: "dummy-decrypted-token" });
    const buildClient = vi.fn(() => noOpClient);

    const result = await runCuratorTick({ store: store!, buildClient });

    expect(result.ran).toBe(true);
    expect(buildClient).toHaveBeenCalledTimes(1);
    // The grooming connection + decrypted token flow into the builder.
    expect(buildClient).toHaveBeenCalledWith(
      { endpoint: "https://api.example.com/v1", model: "gpt-x", timeoutMs: 60_000 },
      "dummy-decrypted-token",
    );
    if (result.ran) expect(result.summary.ran).toBeGreaterThanOrEqual(1);
  });

  it("feeds the grooming addendum from the committed vault file into the prompt (spec 044 D-1)", async () => {
    seedMemory();
    writeCuratorConfig(store!, { enabled: true });
    configureGrooming({ token: "dummy-decrypted-token" });
    // The addendum lives in the committed vault file now, not a setting.
    setJobAddendum(store!, "grooming", "MARKER-ADDENDUM prefer merging over archiving");

    let capturedPrompt = "";
    const capturingClient: LlmClient = {
      complete: async (request: LlmCompletionRequest) => {
        capturedPrompt = request.messages.map((m) => m.content).join("\n");
        return { content: JSON.stringify({ operations: [] }), model: "m", usage: null };
      },
    };

    const result = await runCuratorTick({ store: store!, buildClient: () => capturingClient });

    expect(result.ran).toBe(true);
    // The file's content reached the grooming prompt (it's the OPERATOR GUIDANCE block).
    expect(capturedPrompt).toContain("MARKER-ADDENDUM prefer merging over archiving");
  });

  it("force-proposes (no auto-apply) while the grooming addendum is under_evaluation (spec 044 D-3)", async () => {
    seedMemory();
    // high_confidence so the create would otherwise auto-apply to active.
    writeCuratorConfig(store!, { enabled: true, defaultAutoApply: "high_confidence" });
    configureGrooming({ token: "dummy-decrypted-token" });
    setJobAddendum(store!, "grooming", "freshly changed guidance");
    setAddendumStatus(store!, "grooming", "under_evaluation");
    const evalVersion = store!.readAddendum("grooming").version;

    // The grooming LLM emits a high-confidence create that would auto-apply.
    const createClient: LlmClient = {
      complete: async () => ({
        content: JSON.stringify({
          operations: [
            {
              type: "create",
              memory: {
                title: "Curator fact",
                body: "a durable lesson",
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

    const result = await runCuratorTick({ store: store!, buildClient: () => createClient });
    expect(result.ran).toBe(true);

    // Nothing active was created by the curator…
    expect(store!.searchMemories({ query: "Curator", status: "active" })).toEqual([]);
    // …it's a proposal, tagged with the eval version.
    const proposed = store!.searchMemories({ query: "Curator", status: "proposed" });
    expect(proposed.length).toBe(1);
    expect(proposed[0]?.curator_note?.addendum_version).toBe(evalVersion);
  });

  it("omits the operator-guidance block when the grooming addendum file is absent", async () => {
    seedMemory();
    writeCuratorConfig(store!, { enabled: true });
    configureGrooming({ token: "dummy-decrypted-token" });
    // No addendum file written → fail-soft empty → today's behaviour (no guidance).

    let capturedPrompt = "";
    const capturingClient: LlmClient = {
      complete: async (request: LlmCompletionRequest) => {
        capturedPrompt = request.messages.map((m) => m.content).join("\n");
        return { content: JSON.stringify({ operations: [] }), model: "m", usage: null };
      },
    };

    const result = await runCuratorTick({ store: store!, buildClient: () => capturingClient });

    expect(result.ran).toBe(true);
    expect(capturedPrompt).not.toContain("OPERATOR GUIDANCE");
  });
});

describe("runCuratorTick — token undecryptable without the master key", () => {
  it("does not run when the configured token can't be decrypted", async () => {
    writeCuratorConfig(store!, { enabled: true });
    configureGrooming({ token: "dummy-secret" });
    store!.close();

    // Reopen WITHOUT the master key: the provider still reads as having a token
    // (presence is metadata), but it can't be decrypted → not runnable.
    store = createLibrarianStore({ dataDir });
    const result = await runCuratorTick({ store: store!, buildClient: () => noOpClient });
    expect(result).toEqual({ ran: false, reason: "no_token" });
  });
});
