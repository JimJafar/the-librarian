import { describe, expect, it } from "vitest";
import { HARNESS_IDS, allHarnesses, isHarnessId, registry } from "../src/harnesses/index.js";

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

  it("every module implements the four operations", () => {
    for (const h of allHarnesses) {
      expect(typeof h.detect).toBe("function");
      expect(typeof h.install).toBe("function");
      expect(typeof h.uninstall).toBe("function");
      expect(typeof h.update).toBe("function");
    }
  });
});
