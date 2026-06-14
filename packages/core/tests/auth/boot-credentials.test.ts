import path from "node:path";
import { type FileIo, resolveBootCredentials, resolveSecretKey } from "@librarian/core";
import { describe, expect, it } from "vitest";

const KEY_HEX = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
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
      io,
    });
    expect(r.secretKey?.equals(resolveSecretKey(KEY_HEX))).toBe(true);
    expect(files.has(KEY_PATH)).toBe(false);
    expect(r.signals).toContainEqual({ credential: "secret-key", source: "env" });
  });

  it("reads an existing key file", () => {
    const { io } = fakeFs({ files: { [KEY_PATH]: KEY_HEX } });
    const r = resolveBootCredentials({ env: {}, dataDir: DATA, io });
    expect(r.secretKey?.equals(resolveSecretKey(KEY_HEX))).toBe(true);
    expect(r.signals).toContainEqual({ credential: "secret-key", source: "file", path: KEY_PATH });
  });

  it("generates a key file when absent and the volume is writable", () => {
    const { io, files } = fakeFs();
    const r = resolveBootCredentials({ env: {}, dataDir: DATA, io });
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
    const r = resolveBootCredentials({ env: {}, dataDir: DATA, io });
    expect(r.secretKey).toBeNull();
    expect(files.has(KEY_PATH)).toBe(false);
    expect(r.signals).toContainEqual({ credential: "secret-key", source: "absent" });
  });

  it("throws on a malformed existing key file (fail loud, not fall back)", () => {
    const { io } = fakeFs({ files: { [KEY_PATH]: "garbage" } });
    expect(() => resolveBootCredentials({ env: {}, dataDir: DATA, io })).toThrow(/32 bytes/i);
  });
});

// ADR 0008 P3: the admin token is no longer a boot credential. The internal tRPC
// listener is trusted (off the network), so boot neither resolves, generates, nor
// persists an admin token. resolveBootCredentials carries ONLY the master key.
describe("resolveBootCredentials — admin token dropped (ADR 0008 P3)", () => {
  it("never returns an admin token and never writes /data/admin.token", () => {
    const { io, files } = fakeFs();
    const r = resolveBootCredentials({
      // Even with the env var (or its legacy alias) set, boot ignores it as a
      // credential — the token is no longer a network gate.
      env: { LIBRARIAN_ADMIN_TOKEN: "supplied-token", LIBRARIAN_AUTH_TOKEN: "legacy-token" },
      dataDir: DATA,
      io,
    });
    expect(r).not.toHaveProperty("adminToken");
    expect(files.has(TOKEN_PATH)).toBe(false);
    expect(r.signals.every((s) => s.credential !== "admin-token")).toBe(true);
  });

  it("does not generate an admin token even on a fresh, writable volume", () => {
    const { io, files } = fakeFs();
    resolveBootCredentials({ env: {}, dataDir: DATA, io });
    expect(files.has(TOKEN_PATH)).toBe(false);
  });
});
