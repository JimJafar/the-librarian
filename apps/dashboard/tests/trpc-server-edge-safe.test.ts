import { afterEach, describe, expect, it, vi } from "vitest";

// Regression: `trpc-server.ts` must not touch `process.stderr` at module init.
// It is `import "server-only"`, but Next's middleware bundler still pulls it into
// the EDGE runtime via auth-config-client.ts → middleware.ts, where
// `process.stderr` is undefined — so a module-init `process.stderr.write` throws
// and every request 500s (only when the misconfig warning fires, i.e. neither
// LIBRARIAN_TRPC_URL nor LIBRARIAN_SERVER_URL is set). The cold-start warning
// must use `console.warn` (edge-safe), never `process.stderr.write`.

const PRIOR = {
  trpc: process.env.LIBRARIAN_TRPC_URL,
  server: process.env.LIBRARIAN_SERVER_URL,
};

afterEach(() => {
  vi.restoreAllMocks();
  if (PRIOR.trpc === undefined) delete process.env.LIBRARIAN_TRPC_URL;
  else process.env.LIBRARIAN_TRPC_URL = PRIOR.trpc;
  if (PRIOR.server === undefined) delete process.env.LIBRARIAN_SERVER_URL;
  else process.env.LIBRARIAN_SERVER_URL = PRIOR.server;
});

describe("trpc-server module init is edge-safe", () => {
  it("warns via console.warn (never process.stderr) when neither URL is set", async () => {
    delete process.env.LIBRARIAN_TRPC_URL;
    delete process.env.LIBRARIAN_SERVER_URL;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    vi.resetModules();
    await import("@/lib/trpc-server");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.join(" ")).toContain("LIBRARIAN_TRPC_URL");
    // The edge runtime has no process.stderr — the warning must not reach it.
    expect(stderrWrite.mock.calls.flat().join(" ")).not.toContain("LIBRARIAN_TRPC_URL");
  });

  it("stays silent when LIBRARIAN_TRPC_URL is set (configured deploy)", async () => {
    process.env.LIBRARIAN_TRPC_URL = "http://mcp-server:3840";
    delete process.env.LIBRARIAN_SERVER_URL;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.resetModules();
    await import("@/lib/trpc-server");

    expect(warn).not.toHaveBeenCalled();
  });
});
