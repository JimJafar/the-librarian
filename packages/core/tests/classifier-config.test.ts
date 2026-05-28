// Classifier admin config — read/write through the settings store,
// mirrors curator-config.test.ts in shape. Covers defaults, the
// provider-mode branch, validation, isOperational truth table,
// secret-never-on-reads, and the legacy env-key detection.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  type ClassifierConfigPatch,
  classifierConfigHash,
  createLibrarianStore,
  findLegacyClassifierEnvKeys,
  readClassifierConfig,
  resolveClassifierToken,
  resolveSecretKey,
  writeClassifierConfig,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const KEY = resolveSecretKey("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");

interface Scope {
  store: LibrarianStore;
  dataDir: string;
}

function scope(): Scope {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-classifier-cfg-"));
  const store = createLibrarianStore({ dataDir, secretKey: KEY });
  return { store, dataDir };
}

function teardown(s: Scope | null): void {
  if (!s) return;
  try {
    s.store.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(s.dataDir, { recursive: true, force: true });
}

describe("classifier config", () => {
  let s: Scope | null = null;
  beforeEach(() => {
    s = scope();
  });
  afterEach(() => {
    teardown(s);
    s = null;
  });

  describe("readClassifierConfig defaults", () => {
    it("returns sensible defaults on a fresh store", () => {
      const cfg = readClassifierConfig(s!.store);
      expect(cfg.enabled).toBe(false);
      expect(cfg.providerMode).toBe("remote");
      expect(cfg.llm.provider).toBe("");
      expect(cfg.llm.endpoint).toBe("");
      expect(cfg.llm.model).toBe("");
      expect(cfg.llm.timeoutMs).toBe(60_000);
      expect(cfg.hasToken).toBe(false);
      expect(cfg.isLlmComplete).toBe(false);
      expect(cfg.local.modelId).toBe("");
      expect(cfg.local.quant).toBeNull();
      expect(cfg.promptVersion).toBeNull();
      expect(cfg.isOperational).toBe(false);
    });
  });

  describe("isOperational truth table", () => {
    it("remote: needs enabled + complete LLM connection", () => {
      const { store } = s!;
      writeClassifierConfig(store, {
        enabled: true,
        providerMode: "remote",
        llm: {
          provider: "openai",
          endpoint: "https://api.openai.com/v1",
          model: "gpt-4o-mini",
        },
      });
      // Token missing → not operational.
      expect(readClassifierConfig(store).isOperational).toBe(false);
      writeClassifierConfig(store, { token: "dummy-classifier-token" });
      expect(readClassifierConfig(store).isOperational).toBe(true);
    });

    it("remote: enabled=false → not operational even with full LLM", () => {
      const { store } = s!;
      writeClassifierConfig(store, {
        enabled: false,
        providerMode: "remote",
        llm: {
          provider: "openai",
          endpoint: "https://api.openai.com/v1",
          model: "gpt-4o-mini",
        },
        token: "dummy-classifier-token",
      });
      expect(readClassifierConfig(store).isOperational).toBe(false);
    });

    it("local: needs enabled + modelId; LLM connection block ignored", () => {
      const { store } = s!;
      writeClassifierConfig(store, {
        enabled: true,
        providerMode: "local",
      });
      // modelId missing → not operational.
      expect(readClassifierConfig(store).isOperational).toBe(false);
      writeClassifierConfig(store, { local: { modelId: "Phi-3-mini-4k-instruct-q4" } });
      expect(readClassifierConfig(store).isOperational).toBe(true);
    });

    it("local: enabled=false → not operational even with modelId", () => {
      const { store } = s!;
      writeClassifierConfig(store, {
        enabled: false,
        providerMode: "local",
        local: { modelId: "Phi-3-mini-4k-instruct-q4" },
      });
      expect(readClassifierConfig(store).isOperational).toBe(false);
    });
  });

  describe("writeClassifierConfig validation", () => {
    it("rejects an invalid provider mode", () => {
      const { store } = s!;
      expect(() =>
        writeClassifierConfig(store, {
          providerMode: "elsewhere" as unknown as "remote",
        }),
      ).toThrow(/provider/i);
    });

    it("rejects a promptVersion that doesn't match /^v\\d+$/", () => {
      const { store } = s!;
      expect(() => writeClassifierConfig(store, { promptVersion: "latest" })).toThrow(/prompt/i);
      expect(() => writeClassifierConfig(store, { promptVersion: "" })).toThrow(/prompt/i);
      // null clears it (allowed):
      expect(() => writeClassifierConfig(store, { promptVersion: null })).not.toThrow();
      // Valid versions:
      expect(() => writeClassifierConfig(store, { promptVersion: "v1" })).not.toThrow();
      expect(() => writeClassifierConfig(store, { promptVersion: "v42" })).not.toThrow();
    });

    it("delegates timeoutMs validation to the shared helper", () => {
      const { store } = s!;
      expect(() => writeClassifierConfig(store, { llm: { timeoutMs: 0 } })).toThrow(/timeout/i);
      expect(() => writeClassifierConfig(store, { llm: { timeoutMs: 600_001 } })).toThrow(
        /timeout/i,
      );
    });
  });

  describe("token plumbing", () => {
    it("never returns the token plaintext from readClassifierConfig", () => {
      const { store } = s!;
      writeClassifierConfig(store, { token: "dummy-classifier-token" });
      const cfg = readClassifierConfig(store);
      expect(cfg.hasToken).toBe(true);
      expect(JSON.stringify(cfg)).not.toContain("dummy-classifier-token");
    });

    it("empty-string token clears the value", () => {
      const { store } = s!;
      writeClassifierConfig(store, { token: "dummy-classifier-token" });
      expect(readClassifierConfig(store).hasToken).toBe(true);
      writeClassifierConfig(store, { token: "" });
      expect(readClassifierConfig(store).hasToken).toBe(false);
    });

    it("resolveClassifierToken decrypts when present, returns null when not", () => {
      const { store } = s!;
      expect(resolveClassifierToken(store)).toBeNull();
      writeClassifierConfig(store, { token: "dummy-resolved-token" });
      expect(resolveClassifierToken(store)).toBe("dummy-resolved-token");
    });
  });

  describe("mode switching preserves both halves", () => {
    it("setting local fields doesn't clobber remote LLM settings", () => {
      const { store } = s!;
      writeClassifierConfig(store, {
        providerMode: "remote",
        llm: {
          provider: "openai",
          endpoint: "https://api.openai.com/v1",
          model: "gpt-4o-mini",
        },
        token: "dummy-classifier-token",
      });
      writeClassifierConfig(store, {
        providerMode: "local",
        local: { modelId: "Phi-3-mini-4k-instruct-q4", quant: "Q4_K_M" },
      });
      const cfg = readClassifierConfig(store);
      expect(cfg.providerMode).toBe("local");
      // Remote half preserved:
      expect(cfg.llm.provider).toBe("openai");
      expect(cfg.llm.model).toBe("gpt-4o-mini");
      expect(cfg.hasToken).toBe(true);
      // Local half written:
      expect(cfg.local.modelId).toBe("Phi-3-mini-4k-instruct-q4");
      expect(cfg.local.quant).toBe("Q4_K_M");
    });
  });

  describe("findLegacyClassifierEnvKeys", () => {
    it("returns retired LIBRARIAN_CLASSIFIER_* keys present in env, in declaration order", () => {
      const env = {
        LIBRARIAN_CLASSIFIER_PROVIDER: "remote",
        LIBRARIAN_CLASSIFIER_REMOTE_MODEL: "gpt-4o-mini",
        LIBRARIAN_CLASSIFIER_ENABLED: "true",
        OTHER_VAR: "ignored",
      };
      expect(findLegacyClassifierEnvKeys(env)).toEqual([
        "LIBRARIAN_CLASSIFIER_ENABLED",
        "LIBRARIAN_CLASSIFIER_PROVIDER",
        "LIBRARIAN_CLASSIFIER_REMOTE_MODEL",
      ]);
    });

    it("returns an empty array when no retired key is set", () => {
      expect(findLegacyClassifierEnvKeys({ HOME: "/tmp" })).toEqual([]);
    });

    it("ignores keys with an empty value (unset semantics for shells that export blanks)", () => {
      const env = {
        LIBRARIAN_CLASSIFIER_ENABLED: "",
        LIBRARIAN_CLASSIFIER_PROVIDER: "remote",
      };
      expect(findLegacyClassifierEnvKeys(env)).toEqual(["LIBRARIAN_CLASSIFIER_PROVIDER"]);
    });
  });

  describe("classifierConfigHash (T2.2)", () => {
    it("is stable across repeated reads of the same store", () => {
      const { store } = s!;
      writeClassifierConfig(store, {
        enabled: true,
        providerMode: "remote",
        llm: { provider: "openai", endpoint: "https://api.openai.com/v1", model: "gpt-4o-mini" },
        token: "dummy-classifier-token",
      });
      const h1 = classifierConfigHash(store);
      const h2 = classifierConfigHash(store);
      expect(h1).toBe(h2);
    });

    it("changes when any field changes", () => {
      const { store } = s!;
      writeClassifierConfig(store, {
        enabled: true,
        providerMode: "remote",
        llm: { provider: "openai", endpoint: "https://api.openai.com/v1", model: "gpt-4o-mini" },
        token: "dummy-classifier-token",
      });
      const before = classifierConfigHash(store);

      // Model change:
      writeClassifierConfig(store, { llm: { model: "gpt-4o" } });
      expect(classifierConfigHash(store)).not.toBe(before);
    });

    it("changes when the token is rotated (same key, new encrypted value)", () => {
      const { store } = s!;
      writeClassifierConfig(store, { token: "dummy-classifier-token" });
      const before = classifierConfigHash(store);
      writeClassifierConfig(store, { token: "dummy-rotated-token" });
      expect(classifierConfigHash(store)).not.toBe(before);
    });

    it("the final hex digest never contains the plaintext token", () => {
      const { store } = s!;
      writeClassifierConfig(store, {
        enabled: true,
        token: "dummy-classifier-token",
      });
      // sha256 hex is 64 chars from {0-9a-f}, so the plaintext can't appear
      // by accident — but pin the property so a future refactor that
      // accidentally embeds the plaintext in the canonical payload would
      // fail loudly here.
      const digest = classifierConfigHash(store);
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      expect(digest).not.toContain("dummy-classifier-token");
    });
  });

  describe("ClassifierConfigPatchSchema (validation at the tRPC boundary)", () => {
    it("accepts a fully-populated remote patch", async () => {
      const { ClassifierConfigPatchSchema } = await import("@librarian/core");
      const patch: ClassifierConfigPatch = {
        enabled: true,
        providerMode: "remote",
        llm: {
          provider: "openai",
          endpoint: "https://api.openai.com/v1",
          model: "gpt-4o-mini",
          timeoutMs: 30_000,
        },
        token: "dummy-classifier-token",
        promptVersion: "v1",
      };
      expect(() => ClassifierConfigPatchSchema.parse(patch)).not.toThrow();
    });

    it("accepts a fully-populated local patch", async () => {
      const { ClassifierConfigPatchSchema } = await import("@librarian/core");
      const patch: ClassifierConfigPatch = {
        enabled: true,
        providerMode: "local",
        local: { modelId: "Phi-3-mini-4k-instruct-q4", quant: "Q4_K_M" },
      };
      expect(() => ClassifierConfigPatchSchema.parse(patch)).not.toThrow();
    });

    it("rejects unknown top-level keys (strict schema)", async () => {
      const { ClassifierConfigPatchSchema } = await import("@librarian/core");
      expect(() =>
        ClassifierConfigPatchSchema.parse({
          enabled: true,
          unknown: "stop",
        }),
      ).toThrow();
    });
  });
});
