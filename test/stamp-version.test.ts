// Guards the version-sync mechanism the npm publish relies on. `@the-librarian/cli`
// is published from the root version (stamped at publish time); the bug this
// prevents is the published package's version drifting from the root and the
// publish silently no-op'ing on the stale version (npm froze at rc.5 while the
// root reached rc.20+). See scripts/stamp-version.mjs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXTRA_MANIFESTS, stampAll, stampPackageJson } from "../scripts/stamp-version.mjs";

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

describe("stampAll — also syncs public integration manifests", () => {
  it("includes the Pi extension in EXTRA_MANIFESTS", () => {
    expect(EXTRA_MANIFESTS).toContain("integrations/pi/package.json");
  });

  it("stamps a public integration manifest (the Pi extension) to the root version", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "stampall-"));
    try {
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "1.0.0-rc.34" }));
      const piDir = path.join(root, "integrations", "pi");
      fs.mkdirSync(piDir, { recursive: true });
      fs.writeFileSync(
        path.join(piDir, "package.json"),
        JSON.stringify({ name: "@the-librarian/pi-extension", version: "1.0.0-rc.2" }),
      );

      const { rootVersion, changed } = stampAll(root);

      expect(rootVersion).toBe("1.0.0-rc.34");
      expect(changed).toContain("integrations/pi/package.json");
      const piPkg = JSON.parse(fs.readFileSync(path.join(piDir, "package.json"), "utf8"));
      expect(piPkg.version).toBe("1.0.0-rc.34");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
