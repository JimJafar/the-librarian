import path from "node:path";
import { type FileIo, resolveBootCredentials, resolveSecretKey } from "@librarian/core";
import { describe, expect, it } from "vitest";

const KEY_HEX = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const ADMIN_TOKEN = `libadmin_${Buffer.from("z".repeat(40)).toString("base64url")}`;
const DATA = "/data";
const KEY_PATH = path.join(DATA, "secret.key");
const TOKEN_PATH = path.join(DATA, "admin.token");

// An in-memory FileIo: models file presence and a writable/read-only volume.
function fakeFs(opts: { files?: Record<string, string>; writable?: boolean } = {}) {
  const files = new Map(Object.entries(opts.files ?? {}));
  const writable = opts.writable ?? true;
  const io: FileIo = {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
      const v = files.get(p);
      if (v === undefined) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return v;
    },
    writeFileSync: (p, data) => {
      if (!writable) {
        const err = new Error(`EROFS: read-only file system, ${p}`) as NodeJS.ErrnoException;
        err.code = "EROFS";
        throw err;
      }
      files.set(p, data);
    },
  };
  return { io, files };
}

describe("resolveBootCredentials — secret key matrix", () => {
  it("uses the env key and writes no file", () => {
    const { io, files } = fakeFs();
    const r = resolveBootCredentials({
      env: { LIBRARIAN_SECRET_KEY: KEY_HEX },
      dataDir: DATA,
      boundBeyondLocalhost: false,
      io,
    });
    expect(r.secretKey?.equals(resolveSecretKey(KEY_HEX))).toBe(true);
    expect(files.has(KEY_PATH)).toBe(false);
    expect(r.signals).toContainEqual({ credential: "secret-key", source: "env" });
  });

  it("reads an existing key file", () => {
    const { io } = fakeFs({ files: { [KEY_PATH]: KEY_HEX } });
    const r = resolveBootCredentials({ env: {}, dataDir: DATA, boundBeyondLocalhost: false, io });
    expect(r.secretKey?.equals(resolveSecretKey(KEY_HEX))).toBe(true);
    expect(r.signals).toContainEqual({ credential: "secret-key", source: "file", path: KEY_PATH });
  });

  it("generates a key file when absent and the volume is writable", () => {
    const { io, files } = fakeFs();
    const r = resolveBootCredentials({ env: {}, dataDir: DATA, boundBeyondLocalhost: false, io });
    expect(r.secretKey).not.toBeNull();
    expect(files.has(KEY_PATH)).toBe(true);
    expect(r.signals).toContainEqual({
      credential: "secret-key",
      source: "generated",
      path: KEY_PATH,
    });
  });

  it("falls back to no key (null) when absent and the volume is read-only — never crashes", () => {
    const { io, files } = fakeFs({ writable: false });
    const r = resolveBootCredentials({ env: {}, dataDir: DATA, boundBeyondLocalhost: false, io });
    expect(r.secretKey).toBeNull();
    expect(files.has(KEY_PATH)).toBe(false);
    expect(r.signals).toContainEqual({ credential: "secret-key", source: "absent" });
  });

  it("throws on a malformed existing key file (fail loud, not fall back)", () => {
    const { io } = fakeFs({ files: { [KEY_PATH]: "garbage" } });
    expect(() =>
      resolveBootCredentials({ env: {}, dataDir: DATA, boundBeyondLocalhost: false, io }),
    ).toThrow(/32 bytes/i);
  });
});

describe("resolveBootCredentials — admin token matrix", () => {
  it("uses LIBRARIAN_ADMIN_TOKEN from env", () => {
    const { io, files } = fakeFs();
    const r = resolveBootCredentials({
      env: { LIBRARIAN_ADMIN_TOKEN: "supplied-token" },
      dataDir: DATA,
      boundBeyondLocalhost: true,
      io,
    });
    expect(r.adminToken).toBe("supplied-token");
    expect(files.has(TOKEN_PATH)).toBe(false);
    expect(r.signals).toContainEqual({ credential: "admin-token", source: "env" });
  });

  it("accepts the legacy LIBRARIAN_AUTH_TOKEN as the admin token", () => {
    const { io } = fakeFs();
    const r = resolveBootCredentials({
      env: { LIBRARIAN_AUTH_TOKEN: "legacy-token" },
      dataDir: DATA,
      boundBeyondLocalhost: true,
      io,
    });
    expect(r.adminToken).toBe("legacy-token");
  });

  it("generates an admin token when bound beyond localhost, absent, and writable", () => {
    const { io, files } = fakeFs();
    const r = resolveBootCredentials({ env: {}, dataDir: DATA, boundBeyondLocalhost: true, io });
    expect(r.adminToken).toMatch(/^libadmin_/);
    expect(files.has(TOKEN_PATH)).toBe(true);
    expect(r.signals).toContainEqual({
      credential: "admin-token",
      source: "generated",
      path: TOKEN_PATH,
    });
  });

  it("reads an existing admin token file", () => {
    const { io } = fakeFs({ files: { [TOKEN_PATH]: ADMIN_TOKEN } });
    const r = resolveBootCredentials({ env: {}, dataDir: DATA, boundBeyondLocalhost: true, io });
    expect(r.adminToken).toBe(ADMIN_TOKEN);
    expect(r.signals).toContainEqual({
      credential: "admin-token",
      source: "file",
      path: TOKEN_PATH,
    });
  });

  it("on localhost with no token, returns no token and writes nothing (bypass unchanged)", () => {
    const { io, files } = fakeFs();
    const r = resolveBootCredentials({ env: {}, dataDir: DATA, boundBeyondLocalhost: false, io });
    expect(r.adminToken).toBeNull();
    expect(files.has(TOKEN_PATH)).toBe(false);
    expect(r.signals).toContainEqual({ credential: "admin-token", source: "absent" });
  });

  it("does not crash when bound beyond localhost but the volume is read-only", () => {
    const { io } = fakeFs({ writable: false });
    const r = resolveBootCredentials({ env: {}, dataDir: DATA, boundBeyondLocalhost: true, io });
    expect(r.adminToken).toBeNull();
    expect(r.signals).toContainEqual({ credential: "admin-token", source: "absent" });
  });
});
