import { describe, expect, it } from "vitest";
import { statusLabel, statusPillVariant, vaultPathHref } from "@/lib/ingest-format";

describe("statusPillVariant", () => {
  it("spends the rubric accent on a failure (the one row that needs attention)", () => {
    expect(statusPillVariant("failed")).toBe("accent");
  });
  it("uses muted for pending and the neutral default for success", () => {
    expect(statusPillVariant("pending")).toBe("muted");
    expect(statusPillVariant("success")).toBe("default");
  });
});

describe("statusLabel", () => {
  it("reads as prose, not the machine value", () => {
    expect(statusLabel("failed")).toBe("Failed");
    expect(statusLabel("pending")).toBe("Pending");
    expect(statusLabel("success")).toBe("Saved");
  });
});

describe("vaultPathHref", () => {
  it("deep-links a result path into the vault explorer, encoded", () => {
    expect(vaultPathHref("references/some article.md")).toBe(
      "/?path=references%2Fsome%20article.md",
    );
  });
  it("returns null when there is no path", () => {
    expect(vaultPathHref(null)).toBeNull();
    expect(vaultPathHref(undefined)).toBeNull();
    expect(vaultPathHref("")).toBeNull();
  });
});
