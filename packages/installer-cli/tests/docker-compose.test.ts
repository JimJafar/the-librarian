// ADR 0008 P2 — static guard on the compose stack's admin-tRPC wiring.
//
// In compose, mcp-server and the dashboard are SEPARATE containers, so the
// dashboard reaches the mcp-server's INTERNAL admin tRPC listener over the docker
// network — not loopback. That requires three things to hold together, and any
// one silently dropped re-exposes the admin surface or breaks the dashboard:
//   1. mcp-server binds its tRPC listener on 0.0.0.0:<trpc-port> so a peer
//      container can reach it (loopback-only would be unreachable across the net);
//   2. that tRPC port is NEVER published to the host (no `-p`) — the boundary is
//      the docker network, not a bearer token (ADR 0008 "defense by not-exposing");
//   3. both services sit on a dedicated `internal: true` network (no other stack)
//      and the dashboard's LIBRARIAN_TRPC_URL points at mcp-server:<trpc-port>.
// A `docker compose up` is slow + needs a daemon, so this is a fast string guard
// on the compose file, mirroring all-in-one-dockerfile.test.ts.

import fs from "node:fs";
import { describe, expect, it } from "vitest";

const TRPC_PORT = "3840"; // the internal listener's default port (LIBRARIAN_TRPC_PORT)

const compose = fs.readFileSync(
  new URL("../../../docker/docker-compose.yml", import.meta.url),
  "utf8",
);

/** The mcp-server service block: from `mcp-server:` to the next top-level service. */
function mcpServerBlock(): string {
  const m = compose.match(/^ {2}mcp-server:\n([\s\S]*?)(?=^ {2}\S|^\S|$(?![\s\S]))/m);
  if (!m) throw new Error("compose: could not locate the mcp-server service block");
  return m[0];
}

/** The dashboard service block. */
function dashboardBlock(): string {
  const m = compose.match(/^ {2}dashboard:\n([\s\S]*?)(?=^ {2}\S|^\S|$(?![\s\S]))/m);
  if (!m) throw new Error("compose: could not locate the dashboard service block");
  return m[0];
}

describe("docker-compose.yml — mcp-server exposes admin tRPC on the docker network only", () => {
  it("binds the tRPC listener on 0.0.0.0 so a peer container can reach it", () => {
    expect(mcpServerBlock()).toMatch(/LIBRARIAN_TRPC_HOST:\s*["']?0\.0\.0\.0["']?/);
  });

  it(`binds the tRPC listener on :${TRPC_PORT}`, () => {
    expect(mcpServerBlock()).toMatch(new RegExp(`LIBRARIAN_TRPC_PORT:\\s*["']?${TRPC_PORT}["']?`));
  });

  it("does NOT publish the tRPC port to the host (no -p for it)", () => {
    // The only published port on mcp-server is the public agent port (3838); the
    // tRPC port must never appear in a `ports:` mapping anywhere in the file.
    expect(compose).not.toMatch(new RegExp(`["']?[\\d.]*:?${TRPC_PORT}:${TRPC_PORT}["']?`));
    expect(compose).not.toMatch(new RegExp(`-\\s*["']?[\\d.]*:?${TRPC_PORT}:`));
  });
});

describe("docker-compose.yml — dedicated internal network for the dashboard↔tRPC link", () => {
  it("declares a network with `internal: true`", () => {
    expect(compose).toMatch(/^networks:/m);
    expect(compose).toMatch(/internal:\s*true/);
  });

  it("puts mcp-server on that network", () => {
    expect(mcpServerBlock()).toMatch(/^\s*networks:/m);
  });

  it("puts the dashboard on that network", () => {
    expect(dashboardBlock()).toMatch(/^\s*networks:/m);
  });
});

describe("docker-compose.yml — dashboard targets the internal tRPC listener", () => {
  it(`sets LIBRARIAN_TRPC_URL to mcp-server:${TRPC_PORT} (the docker-network address)`, () => {
    expect(dashboardBlock()).toMatch(
      new RegExp(`LIBRARIAN_TRPC_URL:\\s*["']?http://mcp-server:${TRPC_PORT}["']?`),
    );
  });

  it("does NOT point the dashboard's tRPC URL at the public agent port (3838)", () => {
    expect(dashboardBlock()).not.toMatch(/LIBRARIAN_TRPC_URL:\s*["']?http:\/\/mcp-server:3838/);
  });
});
