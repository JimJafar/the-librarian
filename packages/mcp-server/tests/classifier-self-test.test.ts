// runClassifierSelfTest — builds a transient classifier from the
// current store config, runs SELF_TEST_INPUT through it, and returns the
// result. The running worker (if any) is untouched.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createLibrarianStore,
  type LibrarianStore,
  type LlmClient,
  type LlmCompletion,
  resolveSecretKey,
  writeClassifierConfig,
} from "@librarian/core";
import { __resetClassifierRuntimeForTests, runClassifierSelfTest } from "@librarian/mcp-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const KEY = resolveSecretKey("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");

let store: LibrarianStore | null = null;
let dataDir = "";

function fakeLlm(impl: () => Promise<LlmCompletion>): LlmClient {
  return { complete: impl as LlmClient["complete"] };
}

/** A complete, operational remote config so the self-test can build. */
function writeOperationalRemoteConfig(s: LibrarianStore): void {
  writeClassifierConfig(s, {
    enabled: true,
    llm: { provider: "openai", endpoint: "https://api.openai.com/v1", model: "gpt-4o-mini" },
    token: "dummy-classifier-token",
  });
}

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

  it("reports outcome=error when enabled but the LLM connection is incomplete", async () => {
    writeClassifierConfig(store!, { enabled: true });
    const result = await runClassifierSelfTest({ store: store! });
    expect(result.outcome).toBe("error");
    expect(result.error).toMatch(/incomplete|connection/i);
  });

  it("reports outcome=ok when the classifier infers a parseable verdict", async () => {
    writeOperationalRemoteConfig(store!);
    const result = await runClassifierSelfTest({
      store: store!,
      _llm: () =>
        fakeLlm(async () => ({
          content: JSON.stringify({ requires_approval: false, is_global: false }),
          model: "gpt-4o-mini",
          usage: null,
        })),
    });
    expect(result.outcome).toBe("ok");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.verdict).toEqual({ requires_approval: false, is_global: false });
  });

  it("reports outcome=fallback when the model can't produce parseable JSON", async () => {
    writeOperationalRemoteConfig(store!);
    const result = await runClassifierSelfTest({
      store: store!,
      _llm: () =>
        fakeLlm(async () => ({
          content: "Sorry, I can't help with that.",
          model: "gpt-4o-mini",
          usage: null,
        })),
    });
    expect(result.outcome).toBe("fallback");
    expect(result.rawOutput).toBe("Sorry, I can't help with that.");
  });
});
