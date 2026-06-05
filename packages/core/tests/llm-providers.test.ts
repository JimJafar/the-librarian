// Named LLM provider store (spec 042 §1) — a provider *list* modelled on the
// flat single-string settings store: `llm.providers` index + per-provider
// `llm.provider.<id>.{name,endpoint}` (non-secret) + `.token` (secret). Mirrors
// the llm-connection harness: a real LibrarianStore on a temp dir.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  addProvider,
  createLibrarianStore,
  deleteProvider,
  getProvider,
  listProviders,
  resolveProviderToken,
  resolveSecretKey,
  updateProvider,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Assemble the 64-hex test key at runtime — keep a secret-shaped literal out of
// committed source so GitGuardian stays clean (AGENTS.md GitGuardian note).
const KEY = resolveSecretKey("0123456789abcdef".repeat(4));

interface Scope {
  store: LibrarianStore;
  dataDir: string;
}

function scope(): Scope {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-llm-prov-"));
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

// Deterministic id generator for tests (the production default is makeId("prov")).
function seqIds(): () => string {
  let n = 0;
  return () => `prov_test_${++n}`;
}

describe("llm provider store", () => {
  let s: Scope | null = null;
  beforeEach(() => {
    s = scope();
  });
  afterEach(() => {
    teardown(s);
    s = null;
  });

  describe("addProvider / listProviders / getProvider", () => {
    it("returns an empty list when nothing is stored", () => {
      expect(listProviders(s!.store)).toEqual([]);
    });

    it("creates a provider with a generated id and lists it back", () => {
      const { store } = s!;
      const created = addProvider(
        store,
        { name: "OpenAI", endpoint: "https://api.openai.com/v1", token: "dummy-openai-token" },
        { generateId: seqIds() },
      );
      expect(created.id).toBe("prov_test_1");
      expect(created.name).toBe("OpenAI");
      expect(created.endpoint).toBe("https://api.openai.com/v1");
      expect(created.hasToken).toBe(true);

      const list = listProviders(store);
      expect(list).toHaveLength(1);
      expect(list[0]).toEqual(created);
      expect(getProvider(store, created.id)).toEqual(created);
      expect(getProvider(store, "prov_does_not_exist")).toBeNull();
    });

    it("keeps multiple providers with stable, unique ids in insertion order", () => {
      const { store } = s!;
      const gen = seqIds();
      const a = addProvider(
        store,
        { name: "A", endpoint: "https://a.example/v1" },
        { generateId: gen },
      );
      const b = addProvider(
        store,
        { name: "B", endpoint: "https://b.example/v1" },
        { generateId: gen },
      );
      expect(a.id).not.toBe(b.id);
      expect(listProviders(store).map((p) => p.id)).toEqual([a.id, b.id]);
      // A provider added without a token is valid but not token-complete.
      expect(a.hasToken).toBe(false);
    });

    it("rejects a missing name or endpoint with a teaching error", () => {
      const { store } = s!;
      expect(() => addProvider(store, { name: "", endpoint: "https://x.example/v1" })).toThrow(
        /name/i,
      );
      expect(() => addProvider(store, { name: "X", endpoint: "" })).toThrow(/endpoint/i);
    });

    it("rejects an id that is not key-safe, so it can't collide with another provider's namespace", () => {
      const { store } = s!;
      // A `.` in the id would let `llm.provider.<id>.token` bleed into a sibling's keys.
      expect(() =>
        addProvider(
          store,
          { name: "X", endpoint: "https://x.example/v1" },
          { generateId: () => "bad.id" },
        ),
      ).toThrow(/id/i);
      expect(listProviders(store)).toEqual([]);
    });
  });

  describe("secret handling", () => {
    it("never round-trips the token — presence-only + decrypt-on-demand", () => {
      const { store } = s!;
      const p = addProvider(
        store,
        { name: "Secret Co", endpoint: "https://s.example/v1", token: "dummy-secret-do-not-leak" },
        { generateId: seqIds() },
      );
      const got = getProvider(store, p.id)!;
      expect(got.hasToken).toBe(true);
      expect(Object.keys(got)).not.toContain("token");
      expect(JSON.stringify(listProviders(store))).not.toContain("dummy-secret");
      // Only the explicit resolver decrypts.
      expect(resolveProviderToken(store, p.id)).toBe("dummy-secret-do-not-leak");
      expect(resolveProviderToken(store, "prov_missing")).toBeNull();
    });
  });

  describe("updateProvider", () => {
    it("patches name/endpoint/token without changing the id", () => {
      const { store } = s!;
      const p = addProvider(
        store,
        { name: "Old", endpoint: "https://old.example/v1" },
        { generateId: seqIds() },
      );
      updateProvider(store, p.id, {
        name: "New",
        endpoint: "https://new.example/v1",
        token: "dummy-tok-1",
      });
      const got = getProvider(store, p.id)!;
      expect(got.id).toBe(p.id);
      expect(got.name).toBe("New");
      expect(got.endpoint).toBe("https://new.example/v1");
      expect(got.hasToken).toBe(true);
    });

    it("clears the token when patched with an empty string", () => {
      const { store } = s!;
      const p = addProvider(
        store,
        { name: "T", endpoint: "https://t.example/v1", token: "dummy-tok-2" },
        { generateId: seqIds() },
      );
      updateProvider(store, p.id, { token: "" });
      expect(getProvider(store, p.id)!.hasToken).toBe(false);
      expect(resolveProviderToken(store, p.id)).toBeNull();
    });

    it("throws a teaching error for an unknown id", () => {
      const { store } = s!;
      expect(() => updateProvider(store, "prov_nope", { name: "X" })).toThrow(
        /unknown|not found|exist/i,
      );
    });
  });

  describe("deleteProvider", () => {
    it("removes the provider, its keys, and its index entry, leaving others intact", () => {
      const { store } = s!;
      const gen = seqIds();
      const a = addProvider(
        store,
        { name: "A", endpoint: "https://a.example/v1", token: "dummy-a" },
        { generateId: gen },
      );
      const b = addProvider(
        store,
        { name: "B", endpoint: "https://b.example/v1", token: "dummy-b" },
        { generateId: gen },
      );

      deleteProvider(store, a.id);

      expect(getProvider(store, a.id)).toBeNull();
      expect(resolveProviderToken(store, a.id)).toBeNull();
      expect(listProviders(store).map((p) => p.id)).toEqual([b.id]);
      // No stray keys left for the deleted provider.
      expect(store.listSettings().some((m) => m.key.startsWith(`llm.provider.${a.id}.`))).toBe(
        false,
      );
    });

    it("is idempotent for an unknown id", () => {
      const { store } = s!;
      expect(() => deleteProvider(store, "prov_ghost")).not.toThrow();
    });
  });

  describe("fail-soft index parsing", () => {
    it("treats a malformed index as empty rather than throwing", () => {
      const { store } = s!;
      store.setSetting("llm.providers", "{not json");
      expect(listProviders(store)).toEqual([]);
    });
  });
});
