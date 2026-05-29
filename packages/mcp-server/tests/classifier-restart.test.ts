// restartClassifierWorker — the restart procedure from
// docs/specs/done/030-classifier-dashboard-config-plan.md (shutdown deep-dive).
//
// Covered:
//   - disabled → enabled: outcome=started
//   - enabled → disabled: outcome=stopped
//   - enabled config change: outcome=restarted
//   - concurrent restart: second call returns already_in_progress
//   - boot failure during the swap: outcome=failed, registry left null,
//     prior worker is already stopped

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createLibrarianStore,
  type LibrarianStore,
  type LlmClient,
  resolveSecretKey,
  writeClassifierConfig,
} from "@librarian/core";
import {
  __resetClassifierRuntimeForTests,
  bootClassifierWorker,
  getRunningWorkerState,
  isClassifierRuntimeActive,
  restartClassifierWorker,
} from "@librarian/mcp-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const KEY = resolveSecretKey("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");

let store: LibrarianStore | null = null;
let dataDir = "";

function seedRemoteComplete(s: LibrarianStore): void {
  writeClassifierConfig(s, {
    enabled: true,
    llm: {
      provider: "openai",
      endpoint: "https://api.example.com/v1",
      model: "gpt-4o-mini",
    },
    token: "dummy-classifier-token",
  });
}

beforeEach(() => {
  __resetClassifierRuntimeForTests();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-classifier-restart-"));
  store = createLibrarianStore({ dataDir, secretKey: KEY });
});

afterEach(async () => {
  try {
    store?.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  store = null;
  __resetClassifierRuntimeForTests();
});

describe("restartClassifierWorker — shutdown ordering", () => {
  it("disabled config → no-op stopped outcome with null hash", async () => {
    const result = await restartClassifierWorker({
      store: store!,
      appendEvent: () => undefined,
    });
    expect(result.outcome).toBe("stopped");
    expect(result.runningConfigHash).toBeNull();
    expect(isClassifierRuntimeActive()).toBe(false);
  });

  it("disabled → enabled: outcome=started, registry populated", async () => {
    seedRemoteComplete(store!);
    const result = await restartClassifierWorker({
      store: store!,
      appendEvent: () => undefined,
    });
    expect(result.outcome).toBe("started");
    expect(result.runningConfigHash).toMatch(/^[0-9a-f]{64}$/);
    expect(isClassifierRuntimeActive()).toBe(true);
    expect(getRunningWorkerState().runningConfigHash).toBe(result.runningConfigHash);
  });

  it("enabled → enabled with config change: outcome=restarted, new hash", async () => {
    seedRemoteComplete(store!);
    const first = bootClassifierWorker({ store: store!, appendEvent: () => undefined });
    expect(first).not.toBeNull();
    const firstHash = getRunningWorkerState().runningConfigHash;

    // Change the model — this should flip the hash.
    writeClassifierConfig(store!, { llm: { model: "gpt-4o" } });

    const result = await restartClassifierWorker({
      store: store!,
      appendEvent: () => undefined,
    });
    expect(result.outcome).toBe("restarted");
    expect(result.runningConfigHash).not.toBe(firstHash);
    expect(isClassifierRuntimeActive()).toBe(true);
  });

  it("enabled → disabled: outcome=stopped, registry cleared", async () => {
    seedRemoteComplete(store!);
    bootClassifierWorker({ store: store!, appendEvent: () => undefined });
    expect(isClassifierRuntimeActive()).toBe(true);

    writeClassifierConfig(store!, { enabled: false });

    const result = await restartClassifierWorker({
      store: store!,
      appendEvent: () => undefined,
    });
    expect(result.outcome).toBe("stopped");
    expect(result.runningConfigHash).toBeNull();
    expect(isClassifierRuntimeActive()).toBe(false);
  });

  it("concurrent restart: second caller coalesces onto already_in_progress", async () => {
    seedRemoteComplete(store!);
    const a = restartClassifierWorker({
      store: store!,
      appendEvent: () => undefined,
    });
    const b = restartClassifierWorker({
      store: store!,
      appendEvent: () => undefined,
    });
    const [resA, resB] = await Promise.all([a, b]);
    // Exactly one of the two reports a real outcome; the other reports
    // already_in_progress. We don't pin which one because the
    // scheduling is implementation-defined.
    const outcomes = [resA.outcome, resB.outcome].sort();
    expect(outcomes).toEqual(["already_in_progress", "started"].sort());
  });

  it("boot failure during the swap: outcome=failed, registry left null", async () => {
    seedRemoteComplete(store!);
    bootClassifierWorker({ store: store!, appendEvent: () => undefined });
    expect(isClassifierRuntimeActive()).toBe(true);

    // Trigger a config change so the worker rebuilds, but inject an LLM
    // factory that throws — the build fails for an operational config,
    // yielding the `failed` outcome with the prior worker already gone.
    writeClassifierConfig(store!, { llm: { model: "gpt-4o" } });
    const throwingLlm = (): LlmClient => {
      throw new Error("simulated boot failure");
    };

    const result = await restartClassifierWorker({
      store: store!,
      appendEvent: () => undefined,
      _llm: throwingLlm,
    });
    expect(result.outcome).toBe("failed");
    expect(result.reason).toMatch(/simulated boot failure/);
    expect(result.runningConfigHash).toBeNull();
    // Prior worker is gone; registry is empty.
    expect(isClassifierRuntimeActive()).toBe(false);
  });
});
