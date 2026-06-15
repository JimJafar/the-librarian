// Guards the version-sync mechanism the npm publish relies on. `@the-librarian/cli`
// is published from the root version (stamped at publish time); the bug this
// prevents is the published package's version drifting from the root and the
// publish silently no-op'ing on the stale version (npm froze at rc.5 while the
// root reached rc.20+). See scripts/stamp-version.mjs.

import { describe, expect, it } from "vitest";
import { stampPackageJson } from "../scripts/stamp-version.mjs";

describe("stampPackageJson", () => {
  it("stamps a public package to the root version", () => {
    const raw = `${JSON.stringify(
      { name: "@the-librarian/cli", version: "1.0.0-rc.5", private: false },
      null,
      2,
    )}\n`;
    const out = stampPackageJson(raw, "1.0.0-rc.21");
    expect(out).not.toBeNull();
    expect(JSON.parse(out).version).toBe("1.0.0-rc.21");
    // Preserves the repo's package.json style (2-space indent + trailing newline).
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toContain('\n  "name"');
  });

  it("leaves private packages untouched (returns null)", () => {
    const raw = JSON.stringify({ name: "@librarian/core", version: "0.0.0", private: true });
    expect(stampPackageJson(raw, "1.0.0-rc.21")).toBeNull();
  });

  it("is a no-op when already at the root version (returns null)", () => {
    const raw = JSON.stringify({ name: "@the-librarian/cli", version: "1.0.0-rc.21" });
    expect(stampPackageJson(raw, "1.0.0-rc.21")).toBeNull();
  });
});
