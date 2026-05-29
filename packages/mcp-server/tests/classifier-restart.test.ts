// restartClassifierWorker — the nine-step procedure from
// docs/specs/classifier-dashboard-config-plan.md (shutdown deep-dive).
//
// Covered:
//   - disabled → enabled: outcome=started
//   - enabled → disabled: outcome=stopped
//   - enabled config change: outcome=restarted, lifecycle terminate called
//   - concurrent restart: second call returns already_in_progress
//   - boot failure during step 8: outcome=failed, registry left null,
//     prior worker is already stopped + lifecycle terminated
//   - local provider: lifecycle.terminate called exactly once per restart

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LocalInferenceClient } from "@librarian/classifier";
import {
  createLibrarianStore,
  type LibrarianStore,
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = resolveSecretKey("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");

let store: LibrarianStore | null = null;
let dataDir = "";

function seedRemoteComplete(s: LibrarianStore): void {
  writeClassifierConfig(s, {
    enabled: true,
    providerMode: "remote",
    llm: {
      provider: "openai",
      endpoint: "https://api.example.com/v1",
      model: "gpt-4o-mini",
    },
    token: "dummy-classifier-token",
  });
}

function seedLocalComplete(s: LibrarianStore): void {
  writeClassifierConfig(s, {
    enabled: true,
    providerMode: "local",
    local: { modelId: "test-local-model" },
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

  it("local provider: lifecycle.terminate called between stop and rebuild", async () => {
    seedLocalComplete(store!);
    const terminate = vi.fn(async () => undefined);
    const inferenceFor = vi.fn((_cfg: { modelId: string; quant?: string }) => {
      const client: LocalInferenceClient & { terminate?: () => Promise<void> } = {
        infer: async () => JSON.stringify({ requires_approval: false, is_global: false }),
        terminate,
      };
      return client;
    });

    // Initial boot.
    bootClassifierWorker({
      store: store!,
      appendEvent: () => undefined,
      _inferenceFor: inferenceFor as never,
    });
    expect(isClassifierRuntimeActive()).toBe(true);
    expect(terminate).not.toHaveBeenCalled();

    // Trigger restart with a config change. The prior lifecycle must
    // be terminated exactly once.
    writeClassifierConfig(store!, { local: { modelId: "different-model" } });
    const result = await restartClassifierWorker({
      store: store!,
      appendEvent: () => undefined,
      _inferenceFor: inferenceFor as never,
    });
    expect(result.outcome).toBe("restarted");
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("boot failure during the swap: outcome=failed, registry left null", async () => {
    seedRemoteComplete(store!);
    bootClassifierWorker({ store: store!, appendEvent: () => undefined });
    expect(isClassifierRuntimeActive()).toBe(true);

    // Now break the config by clearing the token; remote config is
    // incomplete → buildClassifier returns null → outcome=failed.
    // Actually it returns the well-known "stopped" outcome because the
    // post-swap cfg is not operational. The "failed" outcome is for an
    // operational config whose build throws. To simulate, switch to
    // local mode and throw from the inference factory.
    writeClassifierConfig(store!, {
      providerMode: "local",
      local: { modelId: "throws" },
    });
    const inferenceFor = vi.fn(() => {
      throw new Error("simulated boot failure");
    });

    const result = await restartClassifierWorker({
      store: store!,
      appendEvent: () => undefined,
      _inferenceFor: inferenceFor as never,
    });
    expect(result.outcome).toBe("failed");
    expect(result.reason).toMatch(/simulated boot failure/);
    expect(result.runningConfigHash).toBeNull();
    // Prior worker is gone; registry is empty.
    expect(isClassifierRuntimeActive()).toBe(false);
  });
});
