// Consolidator tick (plan 036 Phase 4 / spec 035 §F5) — the config-driven
// entrypoint the scheduler calls. Verifies gating (incomplete config / no
// token / unsupported backend) and that an operational config builds the client
// + runs one inbox sweep. Network-free via an injected client builder.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  type LlmClient,
  addProvider,
  createLibrarianStore,
  resolveSecretKey,
  runConsolidatorTick,
  writeConsumerConfig,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Build the 32-byte master key at runtime from a short, sub-threshold literal so
// no 64-hex string (which GitGuardian reads as a high-entropy secret) sits in the
// committed source. Varied bytes — resolveSecretKey rejects a constant-byte key.
const KEY = resolveSecretKey("0123456789abcdef".repeat(4));

let store: LibrarianStore | null = null;
let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-consol-tick-"));
  store = createLibrarianStore({ dataDir, backend: "markdown", secretKey: KEY });
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

function createJudgmentClient(): LlmClient {
  return {
    complete: async () => ({
      content: JSON.stringify({
        action: "create",
        title: "Anna",
        body: "Anna lives in Berlin.",
        tags: [],
        rationale: "novel",
        confidence: 0.97,
      }),
      model: "m",
      usage: null,
    }),
  };
}

// Point the intake consumer at a provider with a token (042 2A).
function configureLlm() {
  const provider = addProvider(store!, {
    name: "default",
    endpoint: "https://e/v1",
    token: "dummy-decrypted-token",
  });
  writeConsumerConfig(store!, "intake", { providerId: provider.id, model: "gpt-x" });
}

describe("runConsolidatorTick — gating", () => {
  it("does not run when the LLM connection is incomplete (no model/token)", async () => {
    const result = await runConsolidatorTick({ store: store! });
    expect(result).toEqual({ ran: false, reason: "incomplete_config" });
  });

  it("does not run when the configured token can't be decrypted", async () => {
    configureLlm();
    store!.close();
    // Reopen WITHOUT the master key: config reads complete (token presence is
    // metadata), but the token can't be decrypted → not runnable.
    store = createLibrarianStore({ dataDir, backend: "markdown" });
    const result = await runConsolidatorTick({
      store: store!,
      buildClient: () => createJudgmentClient(),
    });
    expect(result).toEqual({ ran: false, reason: "no_token" });
  });
});

describe("runConsolidatorTick — operational", () => {
  it("builds the client from config and runs one inbox sweep", async () => {
    configureLlm();
    store!.submitToInbox("Anna moved to Berlin.");
    const buildClient = vi.fn(() => createJudgmentClient());

    const result = await runConsolidatorTick({ store: store!, buildClient });

    expect(result).toMatchObject({ ran: true, summary: { consolidated: 1 } });
    expect(buildClient).toHaveBeenCalledTimes(1);
    // The decrypted token + the configured connection flow into the builder.
    expect(buildClient).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "https://e/v1", model: "gpt-x" }),
      "dummy-decrypted-token",
    );
    // It filed the submission as a recallable memory.
    expect(
      store!.searchMemories({ query: "Anna", status: "active" }).map((m) => m.title),
    ).toContain("Anna");
  });
});
