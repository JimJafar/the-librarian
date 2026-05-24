// Curator LLM configuration (memory-curator spec §7.1) over the settings store.
//
// Operator-managed config: provider/endpoint/token/model + enable, prompt
// addendum, auto-apply posture, schedule. The token is a secret (encrypted via
// the settings store); the readable config never exposes it — only `hasToken`.
// `readCuratorConfig` works WITHOUT the master key (token presence comes from
// settings metadata), so the cockpit can render config; only the worker's
// `resolveCuratorToken` needs the key.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  createLibrarianStore,
  readCuratorConfig,
  resolveCuratorToken,
  resolveSecretKey,
  writeCuratorConfig,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const KEY = resolveSecretKey("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");

interface Scope {
  store: LibrarianStore;
  dataDir: string;
}

function open(dataDir: string, withKey = true): LibrarianStore {
  return createLibrarianStore(withKey ? { dataDir, secretKey: KEY } : { dataDir });
}

function scope(): Scope {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-curator-cfg-"));
  return { store: open(dataDir), dataDir };
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

describe("curator config", () => {
  let s: Scope | null = null;
  beforeEach(() => {
    s = scope();
  });
  afterEach(() => {
    teardown(s);
    s = null;
  });

  it("returns safe defaults when nothing is configured", () => {
    const cfg = readCuratorConfig(s!.store);
    expect(cfg.enabled).toBe(false);
    expect(cfg.defaultAutoApply).toBe("safe_only");
    expect(cfg.autoApplyConfidence).toBeCloseTo(0.9);
    expect(cfg.hasToken).toBe(false);
    expect(cfg.isLlmComplete).toBe(false);
    expect(cfg.isOperational).toBe(false);
  });

  it("round-trips config and never exposes the token in the readable config", () => {
    const { store } = s!;
    writeCuratorConfig(store, {
      enabled: true,
      llm: { provider: "openai", endpoint: "https://api.example.com/v1", model: "gpt-x" },
      token: "dummy-llm-token",
      promptAddendum: "prefer merging over archiving",
    });
    const cfg = readCuratorConfig(store);
    expect(cfg.llm.provider).toBe("openai");
    expect(cfg.llm.endpoint).toBe("https://api.example.com/v1");
    expect(cfg.llm.model).toBe("gpt-x");
    expect(cfg.hasToken).toBe(true);
    expect(cfg.isLlmComplete).toBe(true);
    expect(cfg.isOperational).toBe(true);
    expect(cfg.promptAddendum).toBe("prefer merging over archiving");
    // The readable config object must not carry the token anywhere.
    expect(JSON.stringify(cfg)).not.toContain("dummy-llm-token");
  });

  it("reports hasToken WITHOUT the master key (cockpit render path)", () => {
    const { store, dataDir } = s!;
    writeCuratorConfig(store, {
      enabled: true,
      llm: { provider: "openai", endpoint: "https://e", model: "m" },
      token: "dummy-secret",
    });
    store.close();
    const noKey = open(dataDir, false);
    s!.store = noKey;
    const cfg = readCuratorConfig(noKey); // must not throw despite the secret token
    expect(cfg.hasToken).toBe(true);
    expect(cfg.isOperational).toBe(true);
  });

  it("resolves the decrypted token for the worker", () => {
    const { store } = s!;
    writeCuratorConfig(store, { token: "dummy-worker-token" });
    expect(resolveCuratorToken(store)).toBe("dummy-worker-token");
  });

  it("returns null token when none is configured", () => {
    expect(resolveCuratorToken(s!.store)).toBeNull();
  });

  it("validates the prompt addendum length (≤ 2 KB)", () => {
    const { store } = s!;
    expect(() => writeCuratorConfig(store, { promptAddendum: "x".repeat(2049) })).toThrow(/2/);
  });

  it("validates default_auto_apply and confidence bounds", () => {
    const { store } = s!;
    expect(() =>
      writeCuratorConfig(store, {
        defaultAutoApply: "yolo" as unknown as "off",
      }),
    ).toThrow(/auto_apply|auto-apply/i);
    expect(() => writeCuratorConfig(store, { autoApplyConfidence: 1.5 })).toThrow(/confidence/i);
    expect(() => writeCuratorConfig(store, { autoApplyConfidence: -0.1 })).toThrow(/confidence/i);
  });
});
