import { afterEach, beforeEach, describe, expect, it } from "vitest";

// P2 (ADR 0008): the admin tRPC API now lives on its OWN internal listener,
// on a different port from the agent /mcp surface — so the dashboard's tRPC
// client targets a distinct LIBRARIAN_TRPC_URL, NOT the agent LIBRARIAN_SERVER_URL.
// LIBRARIAN_TRPC_URL wins; LIBRARIAN_SERVER_URL is the dev fallback so a plain
// `pnpm dev` against a single local server keeps working.

const PRIOR = {
  trpc: process.env.LIBRARIAN_TRPC_URL,
  server: process.env.LIBRARIAN_SERVER_URL,
};

beforeEach(() => {
  delete process.env.LIBRARIAN_TRPC_URL;
  delete process.env.LIBRARIAN_SERVER_URL;
});

afterEach(() => {
  if (PRIOR.trpc === undefined) delete process.env.LIBRARIAN_TRPC_URL;
  else process.env.LIBRARIAN_TRPC_URL = PRIOR.trpc;
  if (PRIOR.server === undefined) delete process.env.LIBRARIAN_SERVER_URL;
  else process.env.LIBRARIAN_SERVER_URL = PRIOR.server;
});

describe("trpc-server resolveTrpcBaseUrl", () => {
  it("targets LIBRARIAN_TRPC_URL when set", async () => {
    process.env.LIBRARIAN_TRPC_URL = "http://mcp-server:3840";
    process.env.LIBRARIAN_SERVER_URL = "http://mcp-server:3838";
    const { resolveTrpcBaseUrl } = await import("@/lib/trpc-server");
    expect(resolveTrpcBaseUrl()).toBe("http://mcp-server:3840");
  });

  it("falls back to LIBRARIAN_SERVER_URL when LIBRARIAN_TRPC_URL is unset (dev)", async () => {
    process.env.LIBRARIAN_SERVER_URL = "http://127.0.0.1:3838";
    const { resolveTrpcBaseUrl } = await import("@/lib/trpc-server");
    expect(resolveTrpcBaseUrl()).toBe("http://127.0.0.1:3838");
  });

  it("falls back to the loopback default when neither is set (dev)", async () => {
    const { resolveTrpcBaseUrl } = await import("@/lib/trpc-server");
    expect(resolveTrpcBaseUrl()).toBe("http://127.0.0.1:3838");
  });
});
