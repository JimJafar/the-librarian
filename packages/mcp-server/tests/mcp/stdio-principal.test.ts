// Spec 061 SC 3 + review fixes 1/7 — the stdio bin's env → Principal resolution.
//
// `resolveStdioPrincipal` is split out of bin/stdio.ts precisely so it is unit-testable
// WITHOUT importing the self-executing bin (which opens a store at module load). Pins the
// env → Principal mapping across all four cases, including the admin-id retention (fix 1)
// and the no-id → local-agent sentinel (SC 3, fix 7).
//
// Imports the compiled artifact (../dist), like the other internal-module suites.

import { SENTINEL_ACTOR_IDS, SYSTEM_ACTOR_IDS } from "@librarian/core";
import { describe, expect, it } from "vitest";
import { resolveStdioPrincipal } from "../../dist/bin/stdio-principal.js";

describe("resolveStdioPrincipal — env → Principal (spec 061 SC 3 + review fixes 1/7)", () => {
  it("no env id → the local-agent sentinel, agent role, and NO boundActorId", () => {
    const p = resolveStdioPrincipal({});
    expect(p).toEqual({
      kind: "agent",
      actorId: SENTINEL_ACTOR_IDS.localhost,
      roles: ["agent"],
      scope: "agent",
    });
    // A sentinel is an attribution fallback, never a binding.
    expect(p).not.toHaveProperty("boundActorId");
  });

  it("LIBRARIAN_STDIO_AGENT_ID=x (agent) → x in BOTH actorId and boundActorId", () => {
    expect(resolveStdioPrincipal({ LIBRARIAN_STDIO_AGENT_ID: "codex" })).toEqual({
      kind: "agent",
      actorId: "codex",
      boundActorId: "codex",
      roles: ["agent"],
      scope: "agent",
    });
  });

  it("LIBRARIAN_STDIO_ROLE=admin with NO id → the dashboard-admin actor, unbound", () => {
    const p = resolveStdioPrincipal({ LIBRARIAN_STDIO_ROLE: "admin" });
    expect(p).toEqual({
      kind: "admin",
      actorId: SYSTEM_ACTOR_IDS.dashboardAdmin,
      roles: ["admin"],
    });
    expect(p).not.toHaveProperty("boundActorId");
  });

  it("LIBRARIAN_STDIO_ROLE=admin WITH an id → the id is RETAINED as the admin binding (fix 1)", () => {
    // The old `{ role: "admin", agentId }` context carried the id into ToolContext.agentId, which
    // store_handoff persists as created_by_agent_id. Retaining it as boundActorId restores that.
    expect(
      resolveStdioPrincipal({ LIBRARIAN_STDIO_ROLE: "admin", LIBRARIAN_STDIO_AGENT_ID: "ops-bot" }),
    ).toEqual({
      kind: "admin",
      actorId: "ops-bot",
      boundActorId: "ops-bot",
      roles: ["admin"],
    });
  });
});
