// Classifier-worker startup helper — verifies env-flag opt-in and
// missing-config skip semantics (plan Section 4d).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLibrarianStore, type LibrarianStore } from "@librarian/core";
import {
  __resetClassifierRuntimeForTests,
  bootClassifierWorker,
  isClassifierRuntimeActive,
} from "@librarian/mcp-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let store: LibrarianStore | null = null;
let dataDir = "";

beforeEach(() => {
  __resetClassifierRuntimeForTests();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-classifier-startup-"));
  store = createLibrarianStore({ dataDir });
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

describe("bootClassifierWorker", () => {
  it("returns null when LIBRARIAN_CLASSIFIER_ENABLED is unset", () => {
    const result = bootClassifierWorker({
      db: store!.db,
      appendEvent: () => undefined,
      env: {},
    });
    expect(result).toBeNull();
  });

  it("returns null when remote provider env is incomplete", () => {
    const result = bootClassifierWorker({
      db: store!.db,
      appendEvent: () => undefined,
      env: {
        LIBRARIAN_CLASSIFIER_ENABLED: "true",
        LIBRARIAN_CLASSIFIER_PROVIDER: "remote",
        // missing endpoint/token/model
      },
    });
    expect(result).toBeNull();
  });

  it("returns null when local model id is unset", () => {
    const result = bootClassifierWorker({
      db: store!.db,
      appendEvent: () => undefined,
      env: {
        LIBRARIAN_CLASSIFIER_ENABLED: "true",
        LIBRARIAN_CLASSIFIER_PROVIDER: "local",
      },
    });
    expect(result).toBeNull();
  });

  it("starts a worker when remote env is complete and flips the runtime flag", async () => {
    expect(isClassifierRuntimeActive()).toBe(false);
    const result = bootClassifierWorker({
      db: store!.db,
      appendEvent: () => undefined,
      env: {
        LIBRARIAN_CLASSIFIER_ENABLED: "true",
        LIBRARIAN_CLASSIFIER_PROVIDER: "remote",
        LIBRARIAN_CLASSIFIER_REMOTE_ENDPOINT: "https://api.example.com/v1",
        LIBRARIAN_CLASSIFIER_REMOTE_TOKEN: "test-token",
        LIBRARIAN_CLASSIFIER_REMOTE_MODEL: "gpt-4o-mini",
      },
    });
    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(true);
    expect(result!.worker.running).toBe(true);
    expect(isClassifierRuntimeActive()).toBe(true);
    await result!.worker.stop();
  });

  it("leaves the runtime flag off when env is incomplete", () => {
    bootClassifierWorker({
      db: store!.db,
      appendEvent: () => undefined,
      env: { LIBRARIAN_CLASSIFIER_ENABLED: "true" },
    });
    expect(isClassifierRuntimeActive()).toBe(false);
  });
});
