// Running-version-vs-latest comparison (shared by the top-bar VersionBadge and
// the auto-update settings panel). Regression for the prerelease bug: an earlier
// comparator dropped the `-rc.N` segment, so `rc.29` and `rc.33` compared equal
// and both surfaces falsely reported "up to date".

import { describe, expect, it } from "vitest";
import { autoUpdateStatus, compareSemver } from "@/components/curator/autoupdate-status";

describe("compareSemver", () => {
  it("orders release fields numerically", () => {
    expect(compareSemver("1.2.0", "1.10.0")).toBe(-1);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
  });

  it("ranks a prerelease below the same released version", () => {
    expect(compareSemver("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBe(1);
  });

  it("compares prerelease identifiers — the rc.29 < rc.33 regression", () => {
    expect(compareSemver("1.0.0-rc.29", "v1.0.0-rc.33")).toBe(-1);
    expect(compareSemver("1.0.0-rc.33", "1.0.0-rc.33")).toBe(0);
    expect(compareSemver("1.0.0-rc.40", "1.0.0-rc.9")).toBe(1); // numeric, not lexical
  });

  it("returns null for unparseable input (conservative 'unknown')", () => {
    expect(compareSemver("not-a-version", "1.0.0")).toBeNull();
    expect(compareSemver("1.0.0", "")).toBeNull();
  });
});

describe("autoUpdateStatus", () => {
  const ok = (tag: string) => ({ kind: "ok" as const, release: { tag }, cachedAt: "x" });

  it("reports 'behind' across prereleases of the same core version (the bug)", () => {
    expect(autoUpdateStatus("1.0.0-rc.29", ok("v1.0.0-rc.33"))).toBe("behind");
  });

  it("reports 'up_to_date' when equal", () => {
    expect(autoUpdateStatus("1.0.0-rc.33", ok("v1.0.0-rc.33"))).toBe("up_to_date");
  });

  it("is 'loading' when latest is undefined and 'unknown' on a non-ok latest", () => {
    expect(autoUpdateStatus("1.0.0", undefined)).toBe("loading");
    expect(autoUpdateStatus("1.0.0", { kind: "unavailable", reason: "x" })).toBe("unknown");
  });
});
