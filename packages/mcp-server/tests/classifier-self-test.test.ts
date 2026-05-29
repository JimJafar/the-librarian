// runClassifierSelfTest — builds a transient classifier from the
// current store config, runs SELF_TEST_INPUT through it, and tears
// down. The running worker (if any) is untouched.

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
import { __resetClassifierRuntimeForTests, runClassifierSelfTest } from "@librarian/mcp-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = resolveSecretKey("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");

let store: LibrarianStore | null = null;
let dataDir = "";

beforeEach(() => {
  __resetClassifierRuntimeForTests();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-classifier-selftest-"));
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
  __resetClassifierRuntimeForTests();
});

describe("runClassifierSelfTest", () => {
  it("reports outcome=error when no config is set (not operational)", async () => {
    const result = await runClassifierSelfTest({ store: store! });
    expect(result.outcome).toBe("error");
    expect(result.error).toMatch(/not operational|disabled|incomplete/i);
  });

  it("reports outcome=ok when local classifier infers a parseable verdict", async () => {
    writeClassifierConfig(store!, {
      enabled: true,
      providerMode: "local",
      local: { modelId: "test-local-model" },
    });
    const inferenceFor = vi.fn(() => {
      const client: LocalInferenceClient = {
        infer: async () => JSON.stringify({ requires_approval: false, is_global: false }),
      };
      return client;
    });
    const result = await runClassifierSelfTest({
      store: store!,
      _inferenceFor: inferenceFor as never,
    });
    expect(result.outcome).toBe("ok");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.verdict).toEqual({ requires_approval: false, is_global: false });
  });

  it("terminates the transient lifecycle even when infer throws", async () => {
    writeClassifierConfig(store!, {
      enabled: true,
      providerMode: "local",
      local: { modelId: "test-local-model" },
    });
    const terminate = vi.fn(async () => undefined);
    const inferenceFor = vi.fn(() => {
      const client: LocalInferenceClient & { terminate?: () => Promise<void> } = {
        infer: async () => {
          throw new Error("simulated inference failure");
        },
        terminate,
      };
      return client;
    });

    const result = await runClassifierSelfTest({
      store: store!,
      _inferenceFor: inferenceFor as never,
    });
    // The classifier's local provider catches inference errors and
    // returns a fallback verdict rather than throwing; the self-test
    // sees a fallback outcome, not an error.
    expect(["fallback", "error"]).toContain(result.outcome);
    // The transient lifecycle was terminated cleanly regardless.
    expect(terminate).toHaveBeenCalledTimes(1);
  });
});
