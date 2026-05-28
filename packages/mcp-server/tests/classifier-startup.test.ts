// Classifier-worker startup helper — store-driven boot (post-rethink, the
// env contract is retired). Cases:
//
//   1. boot returns null when stored config is disabled
//   2. boot returns null when remote config is incomplete
//   3. boot returns a started worker when remote is complete
//   4. boot returns null when local is missing modelId
//   5. boot returns a started worker when local is complete (injected
//      inferenceFor — no real model load)
//   6. legacy env detector emits a notice when any LIBRARIAN_CLASSIFIER_*
//      env is set, regardless of store state
//   7. getRunningWorkerState reflects the registry

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
} from "@librarian/mcp-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = resolveSecretKey("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");

let store: LibrarianStore | null = null;
let dataDir = "";

beforeEach(() => {
  __resetClassifierRuntimeForTests();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-classifier-startup-"));
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

describe("bootClassifierWorker — store-driven", () => {
  it("returns null when stored config is disabled (the default)", () => {
    const result = bootClassifierWorker({
      store: store!,
      appendEvent: () => undefined,
      env: {},
    });
    expect(result).toBeNull();
    expect(isClassifierRuntimeActive()).toBe(false);
    expect(getRunningWorkerState().enabled).toBe(false);
    expect(getRunningWorkerState().runningConfigHash).toBeNull();
  });

  it("returns null when remote config is enabled but incomplete", () => {
    writeClassifierConfig(store!, {
      enabled: true,
      providerMode: "remote",
      llm: { provider: "openai" }, // missing endpoint/model/token
    });
    const result = bootClassifierWorker({
      store: store!,
      appendEvent: () => undefined,
      env: {},
    });
    expect(result).toBeNull();
    expect(isClassifierRuntimeActive()).toBe(false);
  });

  it("starts a worker when remote config is complete and stamps the registry", async () => {
    writeClassifierConfig(store!, {
      enabled: true,
      providerMode: "remote",
      llm: {
        provider: "openai",
        endpoint: "https://api.example.com/v1",
        model: "gpt-4o-mini",
      },
      token: "dummy-classifier-token",
    });
    const result = bootClassifierWorker({
      store: store!,
      appendEvent: () => undefined,
      env: {},
    });
    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(true);
    expect(result!.worker.running).toBe(true);
    expect(isClassifierRuntimeActive()).toBe(true);

    const state = getRunningWorkerState();
    expect(state.enabled).toBe(true);
    expect(state.runningConfigHash).toMatch(/^[0-9a-f]{64}$/);

    await result!.worker.stop();
  });

  it("returns null when local config is enabled but local.modelId is unset", () => {
    writeClassifierConfig(store!, {
      enabled: true,
      providerMode: "local",
    });
    const result = bootClassifierWorker({
      store: store!,
      appendEvent: () => undefined,
      env: {},
    });
    expect(result).toBeNull();
  });

  it("starts a worker when local config is complete (injected inferenceFor)", async () => {
    writeClassifierConfig(store!, {
      enabled: true,
      providerMode: "local",
      local: { modelId: "test-local-model" },
    });
    // Inject a fake inference client so the test doesn't load a real model.
    const stubInferenceFor = vi.fn(() => ({
      classify: async () => ({
        outcome: "ok" as const,
        verdict: { requires_approval: false, is_global: false },
        provider: "local" as const,
        attempts: 1,
        latencyMs: 1,
      }),
    }));
    const result = bootClassifierWorker({
      store: store!,
      appendEvent: () => undefined,
      env: {},
      // Test-only seam — see bootClassifierWorker input shape for the rationale.
      _inferenceFor: stubInferenceFor as never,
    });
    expect(result).not.toBeNull();
    expect(result!.worker.running).toBe(true);
    expect(isClassifierRuntimeActive()).toBe(true);
    await result!.worker.stop();
  });

  it("emits the env-retired notice when any LIBRARIAN_CLASSIFIER_* env is set", () => {
    const log = vi.fn();
    bootClassifierWorker({
      store: store!,
      appendEvent: () => undefined,
      env: {
        LIBRARIAN_CLASSIFIER_ENABLED: "true",
        LIBRARIAN_CLASSIFIER_REMOTE_MODEL: "gpt-4o-mini",
      },
      log,
    });
    const calls = log.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const retirement = calls.find((c) => c.event === "classifier_env_retired");
    expect(retirement).toBeDefined();
    expect(retirement!.level).toBe("warn");
    expect(retirement!.keys).toEqual([
      "LIBRARIAN_CLASSIFIER_ENABLED",
      "LIBRARIAN_CLASSIFIER_REMOTE_MODEL",
    ]);
    expect(retirement!.hint).toMatch(/classifier/i);
  });

  it("does NOT emit the env-retired notice when no LIBRARIAN_CLASSIFIER_* is set", () => {
    const log = vi.fn();
    bootClassifierWorker({
      store: store!,
      appendEvent: () => undefined,
      env: {},
      log,
    });
    const calls = log.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(calls.find((c) => c.event === "classifier_env_retired")).toBeUndefined();
  });
});
