// Claude `SessionStart` awareness + capture-status banner — pure banner-builder
// unit tests (spec 2026-06-16-harness-auto-capture, T5 / SC9).
//
// The hook entry (integrations/claude/scripts/on-session-start.mjs) is a THIN
// shell over the pure builder in integrations/claude/scripts/lib/banner.mjs. The
// banner-string logic — the static awareness line always present, the capture
// status / warning, fail-soft when the status query is unreachable — is asserted
// here.
//
// Coverage map (spec §2 SC9):
//   - active:            reachable + capture enabled + auto-save on → awareness +
//                        "capture is active".
//   - intake-off:        reachable + capture disabled server-side → WARNS, names
//                        the reason (curator intake off) + the fix (dashboard).
//   - auto-save-off:     LIBRARIAN_AUTO_SAVE=false locally → WARNS, names the
//                        reason + the fix (unset the env). Takes precedence (it is
//                        the local kill-switch).
//   - status-unreachable: the /healthz query failed → STILL emits the static
//                        awareness line, NO warning, NO throw (fail-soft).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "./helpers.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = path.join(REPO_ROOT, "integrations", "claude", "scripts", "lib");

const banner = await import(path.join(LIB, "banner.mjs"));

describe("buildBanner — awareness + capture status (SC9)", () => {
  it("ALWAYS includes the static awareness line (the agent has recall/remember)", () => {
    for (const status of [
      { reachable: true, captureEnabled: true },
      { reachable: true, captureEnabled: false },
      { reachable: false },
    ]) {
      const text = banner.buildBanner({ status, env: {} });
      expect(text).toMatch(/recall/);
      expect(text).toMatch(/remember/);
      expect(text).toMatch(/Librarian/i);
    }
  });

  it("active: reachable + capture enabled + auto-save on → says capture is active, no warning", () => {
    const text = banner.buildBanner({
      status: { reachable: true, captureEnabled: true },
      env: {},
    });
    expect(text).toMatch(/capture is active|automatic capture is on|capturing/i);
    expect(text).not.toMatch(/warning|disabled|⚠/i);
  });

  it("intake-off: capture disabled server-side → WARNS naming the reason + the dashboard fix", () => {
    const text = banner.buildBanner({
      status: { reachable: true, captureEnabled: false },
      env: {},
    });
    expect(text).toMatch(/warning|⚠/i);
    // Names the reason (curator intake gate off) and the fix (the dashboard).
    expect(text).toMatch(/intake|curator/i);
    expect(text).toMatch(/dashboard/i);
  });

  it("auto-save-off: LIBRARIAN_AUTO_SAVE=false → WARNS naming the env + the fix (unset it)", () => {
    const text = banner.buildBanner({
      status: { reachable: true, captureEnabled: true },
      env: { LIBRARIAN_AUTO_SAVE: "false" },
    });
    expect(text).toMatch(/warning|⚠/i);
    expect(text).toMatch(/LIBRARIAN_AUTO_SAVE/);
    expect(text).toMatch(/unset/i);
  });

  it("auto-save-off takes precedence over a (would-be) active server state", () => {
    // Even if the server reports capture enabled, the local kill-switch wins —
    // nothing ships from this machine, so the banner must warn about the env.
    const text = banner.buildBanner({
      status: { reachable: true, captureEnabled: true },
      env: { LIBRARIAN_AUTO_SAVE: "false" },
    });
    expect(text).toMatch(/LIBRARIAN_AUTO_SAVE/);
    expect(text).not.toMatch(/capture is active/i);
  });

  it("status-unreachable: query failed → static awareness line ONLY, no warning, no throw", () => {
    const text = banner.buildBanner({
      status: { reachable: false },
      env: {},
    });
    expect(text).toMatch(/recall/);
    expect(text).toMatch(/remember/);
    // Fail-soft: NOT a warning about capture being off (we just don't know).
    expect(text).not.toMatch(/warning|⚠/i);
  });

  it("treats LIBRARIAN_AUTO_SAVE values other than 'false' as on (default-on)", () => {
    for (const v of [undefined, "", "true", "1", "yes"]) {
      const env = v === undefined ? {} : { LIBRARIAN_AUTO_SAVE: v };
      const text = banner.buildBanner({ status: { reachable: true, captureEnabled: true }, env });
      expect(text, `value=${String(v)}`).not.toMatch(/LIBRARIAN_AUTO_SAVE/);
    }
  });
});

describe("isAutoSaveOff — the local kill-switch reader", () => {
  it("is true ONLY for the exact string 'false' (case-insensitive), off by default", () => {
    expect(banner.isAutoSaveOff({})).toBe(false);
    expect(banner.isAutoSaveOff({ LIBRARIAN_AUTO_SAVE: "false" })).toBe(true);
    expect(banner.isAutoSaveOff({ LIBRARIAN_AUTO_SAVE: "FALSE" })).toBe(true);
    expect(banner.isAutoSaveOff({ LIBRARIAN_AUTO_SAVE: "true" })).toBe(false);
    expect(banner.isAutoSaveOff({ LIBRARIAN_AUTO_SAVE: "" })).toBe(false);
  });
});

describe("deriveHealthzUrl — same-origin /healthz from LIBRARIAN_MCP_URL", () => {
  it("rewrites /mcp to /healthz on the same origin", () => {
    expect(banner.deriveHealthzUrl("https://librarian.example.com/mcp")).toBe(
      "https://librarian.example.com/healthz",
    );
    expect(banner.deriveHealthzUrl("http://127.0.0.1:8080/mcp?x=1#f")).toBe(
      "http://127.0.0.1:8080/healthz",
    );
  });
  it("returns null for an unusable URL (→ unreachable, fail-soft)", () => {
    expect(banner.deriveHealthzUrl("")).toBeNull();
    expect(banner.deriveHealthzUrl(undefined)).toBeNull();
    expect(banner.deriveHealthzUrl("not a url")).toBeNull();
  });
});

describe("probeStatus — fail-soft /healthz probe", () => {
  it("returns reachable:false (never throws) when there is no URL", async () => {
    await expect(banner.probeStatus({})).resolves.toEqual({ reachable: false });
  });
  it("returns reachable:false when the fetch rejects (server down)", async () => {
    const failing = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(
      banner.probeStatus({ LIBRARIAN_MCP_URL: "http://127.0.0.1:1/mcp" }, { fetch: failing }),
    ).resolves.toEqual({ reachable: false });
  });
});

// ── live-server end-to-end (SC9 active / intake-off) ─────────────────────────
// Spin up the REAL server and run probeStatus → buildBanner against its /healthz,
// asserting the banner reflects the server's actual capture gate.

describe("probe → banner against a live server (SC9)", () => {
  let serverDataDir = "";
  let server: Awaited<ReturnType<typeof startHttpServer>> | null = null;

  beforeEach(() => {
    serverDataDir = makeTempDir();
  });
  afterEach(async () => {
    if (server) await server.stop();
    server = null;
    if (serverDataDir) cleanupTempDir(serverDataDir);
    serverDataDir = "";
  });

  it("intake gate ON → banner says capture is active", async () => {
    server = await startHttpServer({ dataDir: serverDataDir, intake: "on" });
    const env = {
      LIBRARIAN_MCP_URL: `${server.url}/mcp`,
      LIBRARIAN_AGENT_TOKEN: server.agentToken,
    };
    const status = await banner.probeStatus(env);
    expect(status).toEqual({ reachable: true, captureEnabled: true });
    const text = banner.buildBanner({ status, env });
    expect(text).toMatch(/capture is active/i);
    expect(text).not.toMatch(/⚠/);
  });

  it("intake gate OFF (default) → banner WARNS naming the dashboard fix", async () => {
    server = await startHttpServer({ dataDir: serverDataDir });
    const env = {
      LIBRARIAN_MCP_URL: `${server.url}/mcp`,
      LIBRARIAN_AGENT_TOKEN: server.agentToken,
    };
    const status = await banner.probeStatus(env);
    expect(status).toEqual({ reachable: true, captureEnabled: false });
    const text = banner.buildBanner({ status, env });
    expect(text).toMatch(/⚠/);
    expect(text).toMatch(/dashboard/i);
  });
});
