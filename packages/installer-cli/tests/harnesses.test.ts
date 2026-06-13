import { describe, expect, it } from "vitest";
import {
  HARNESS_IDS,
  allHarnesses,
  isHarnessId,
  NotImplemented,
  registry,
} from "../src/harnesses/index.js";

const CFG = { mcpUrl: "https://x/mcp", token: "t", serverUrl: "https://x" };

describe("harness registry", () => {
  it("lists exactly the five spec'd harness ids", () => {
    expect([...HARNESS_IDS]).toEqual(["claude", "codex", "opencode", "hermes", "pi"]);
  });

  it("registry keys match the id field of each module", () => {
    for (const id of HARNESS_IDS) {
      expect(registry[id].id).toBe(id);
    }
  });

  it("every module has a non-empty display name", () => {
    for (const h of allHarnesses) {
      expect(h.displayName.length).toBeGreaterThan(0);
    }
  });

  it("isHarnessId recognises known ids and rejects others", () => {
    expect(isHarnessId("claude")).toBe(true);
    expect(isHarnessId("nope")).toBe(false);
  });
});

describe("stub harness modules", () => {
  it("detect reports not-installed for every harness", async () => {
    for (const h of allHarnesses) {
      await expect(h.detect()).resolves.toEqual({ installed: false });
    }
  });

  it("install/uninstall/update throw NotImplemented for every harness", async () => {
    for (const h of allHarnesses) {
      await expect(h.install(CFG)).rejects.toBeInstanceOf(NotImplemented);
      await expect(h.uninstall()).rejects.toBeInstanceOf(NotImplemented);
      await expect(h.update(CFG)).rejects.toBeInstanceOf(NotImplemented);
    }
  });
});
