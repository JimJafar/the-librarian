import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadOrCreateAdminTokenFile } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("loadOrCreateAdminTokenFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-admin-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("generates a libadmin_ token (>=32 bytes entropy) in a 0600 file when absent", () => {
    const file = path.join(dir, "admin.token");
    const { token, generated } = loadOrCreateAdminTokenFile(file);
    expect(generated).toBe(true);
    expect(token).toMatch(/^libadmin_[A-Za-z0-9_-]+$/);
    // The random body decodes to exactly 32 bytes of entropy (symmetry with the
    // 32-byte secret key).
    const body = token.slice("libadmin_".length);
    expect(Buffer.from(body, "base64url").length).toBe(32);
    expect(fs.readFileSync(file, "utf8").trim()).toBe(token);
    expect(fs.statSync(file).mode & 0o077).toBe(0);
  });

  it("reuses the existing token on a second call (no regeneration)", () => {
    const file = path.join(dir, "admin.token");
    const first = loadOrCreateAdminTokenFile(file);
    const second = loadOrCreateAdminTokenFile(file);
    expect(second.generated).toBe(false);
    expect(second.token).toBe(first.token);
  });

  it("reads an existing well-formed token without widening perms", () => {
    const file = path.join(dir, "admin.token");
    const existing = `libadmin_${Buffer.from("a".repeat(40)).toString("base64url")}`;
    fs.writeFileSync(file, `${existing}\n`, { mode: 0o600 });
    const { token, generated } = loadOrCreateAdminTokenFile(file);
    expect(generated).toBe(false);
    expect(token).toBe(existing);
    expect(fs.statSync(file).mode & 0o077).toBe(0);
  });

  it("throws on a malformed existing token file (fail loud, never overwrite)", () => {
    const file = path.join(dir, "admin.token");
    fs.writeFileSync(file, "not-an-admin-token");
    expect(() => loadOrCreateAdminTokenFile(file)).toThrow(/admin token/i);
    expect(fs.readFileSync(file, "utf8")).toBe("not-an-admin-token");
  });
});
