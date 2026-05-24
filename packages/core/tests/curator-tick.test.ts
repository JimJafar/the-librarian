// Curator tick (spec §12/§14) — the config-driven entrypoint. Verifies gating
// (disabled / incomplete / undecryptable token) and that an operational config
// builds the client from config and runs due slices. Network-free via an injected
// client builder.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  type LlmClient,
  createLibrarianStore,
  resolveSecretKey,
  runCuratorTick,
  writeCuratorConfig,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = resolveSecretKey("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");

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

describe("runCuratorTick — gating", () => {
  it("does nothing when curation is disabled (the default)", async () => {
    const result = await runCuratorTick({ store: store! });
    expect(result).toEqual({ ran: false, reason: "disabled" });
  });

  it("does nothing when the LLM config is incomplete (no token)", async () => {
    writeCuratorConfig(store!, {
      enabled: true,
      llm: { provider: "openai", endpoint: "https://e/v1", model: "gpt-x" },
    });
    const result = await runCuratorTick({ store: store! });
    expect(result).toEqual({ ran: false, reason: "incomplete_config" });
  });
});

describe("runCuratorTick — operational", () => {
  it("builds the client from config (with the decrypted token) and runs due slices", async () => {
    seedMemory();
    writeCuratorConfig(store!, {
      enabled: true,
      llm: { provider: "openai", endpoint: "https://api.example.com/v1", model: "gpt-x" },
      token: "dummy-decrypted-token",
    });
    const buildClient = vi.fn(() => noOpClient);

    const result = await runCuratorTick({ store: store!, buildClient });

    expect(result.ran).toBe(true);
    expect(buildClient).toHaveBeenCalledTimes(1);
    // The decrypted token + the configured connection flow into the builder.
    expect(buildClient).toHaveBeenCalledWith(
      { provider: "openai", endpoint: "https://api.example.com/v1", model: "gpt-x" },
      "dummy-decrypted-token",
    );
    if (result.ran) expect(result.summary.ran).toBeGreaterThanOrEqual(1);
  });
});

describe("runCuratorTick — token undecryptable without the master key", () => {
  it("does not run when the configured token can't be decrypted", async () => {
    writeCuratorConfig(store!, {
      enabled: true,
      llm: { provider: "openai", endpoint: "https://e/v1", model: "gpt-x" },
      token: "dummy-secret",
    });
    store!.close();

    // Reopen WITHOUT the master key: config still reads as complete (token presence
    // is metadata), but the token can't be decrypted → not runnable.
    store = createLibrarianStore({ dataDir });
    const result = await runCuratorTick({ store: store!, buildClient: () => noOpClient });
    expect(result).toEqual({ ran: false, reason: "no_token" });
  });
});
