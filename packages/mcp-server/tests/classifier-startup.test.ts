// Classifier-worker startup helper — store-driven boot (post-rethink, the
// env contract is retired). Cases:
//
//   1. boot returns null when stored config is disabled
//   2. boot returns null when the LLM connection is incomplete
//   3. boot returns a started worker when the LLM connection is complete
//   4. legacy env detector emits a notice when any LIBRARIAN_CLASSIFIER_*
//      env is set, regardless of store state
//   5. getRunningWorkerState reflects the registry

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

  it("returns null when the config is enabled but the LLM connection is incomplete", () => {
    writeClassifierConfig(store!, {
      enabled: true,
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

  it("starts a worker when the LLM connection is complete and stamps the registry", async () => {
    writeClassifierConfig(store!, {
      enabled: true,
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
