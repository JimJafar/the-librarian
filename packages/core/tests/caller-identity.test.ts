// Agent naming & caller-identity contract — unit coverage.
//
// Pins the load-bearing semantics from
// docs/specs/agent-naming-contract-spec.md:
//   - normaliseCallerId (§4.2 / §4.3 example table)
//   - alias resolution after normalisation, with loop/chain rejection (§4.4)
//   - reserved namespaces system-* / dashboard-* / cli + role gating (§4.4, §6)
//   - resolveCaller precedence, token-binding mismatch, allowlist, soft mode (§5.3, §7.1)
//
// Test list mirrors the spec §11 "Unit tests" bullet points.

import {
  DEFAULT_AGENT_ID,
  SYSTEM_ACTOR_IDS,
  actorKind,
  isReservedId,
  normaliseCallerId,
  resolveCaller,
} from "@librarian/core";
import { describe, expect, it } from "vitest";

describe("normaliseCallerId (§4.2/§4.3)", () => {
  it("lowercases and trims", () => {
    expect(normaliseCallerId("Guybrush")).toBe("guybrush");
    expect(normaliseCallerId(" guybrush ")).toBe("guybrush");
    expect(normaliseCallerId("GUYBRUSH")).toBe("guybrush");
  });

  it("turns punctuation and whitespace into single hyphens", () => {
    expect(normaliseCallerId("Claude Code")).toBe("claude-code");
    expect(normaliseCallerId("claude.code")).toBe("claude-code");
    expect(normaliseCallerId("codex_v2")).toBe("codex-v2");
    expect(normaliseCallerId("Guybrush (Hermes)")).toBe("guybrush-hermes");
  });

  it("collapses repeated separators into one hyphen", () => {
    expect(normaliseCallerId("a   b")).toBe("a-b");
    expect(normaliseCallerId("a---b")).toBe("a-b");
    expect(normaliseCallerId("a..__..b")).toBe("a-b");
  });

  it("strips leading and trailing hyphens", () => {
    expect(normaliseCallerId("-guybrush-")).toBe("guybrush");
    expect(normaliseCallerId("!!!guybrush!!!")).toBe("guybrush");
  });

  it("drops combining marks via NFKD", () => {
    expect(normaliseCallerId("café")).toBe("cafe");
  });

  it("rejects input that normalises to empty", () => {
    expect(() => normaliseCallerId("!!!")).toThrow();
    expect(() => normaliseCallerId("   ")).toThrow();
    expect(() => normaliseCallerId("")).toThrow();
  });

  it("rejects ids longer than 64 chars after normalisation", () => {
    expect(() => normaliseCallerId("a".repeat(65))).toThrow();
    expect(normaliseCallerId("a".repeat(64))).toBe("a".repeat(64));
  });

  it("rejects megabyte-scale raw input cheaply, before normalising", () => {
    expect(() => normaliseCallerId("x".repeat(10_000))).toThrow(/before normalisation/i);
  });

  it("is idempotent", () => {
    const once = normaliseCallerId("Guybrush (Hermes)");
    expect(normaliseCallerId(once)).toBe(once);
  });
});

describe("resolveCaller — identity sources & precedence (§7.1)", () => {
  it("prefers a trusted injected id over a request-body id", () => {
    const resolved = resolveCaller({
      role: "agent",
      injectedAgentId: "guybrush",
      rawAgentId: "attacker",
    });
    expect(resolved.actor_id).toBe("guybrush");
    expect(resolved.raw_id).toBe("attacker");
    expect(resolved.injected_id).toBe("guybrush");
  });

  it("uses the request-body id when no injected id is present", () => {
    const resolved = resolveCaller({ role: "agent", rawAgentId: "Codex" });
    expect(resolved.actor_id).toBe("codex");
  });

  it("falls back to the authenticated (token-bound) id when nothing else is supplied", () => {
    const resolved = resolveCaller({ role: "agent", authenticatedAgentId: "guybrush" });
    expect(resolved.actor_id).toBe("guybrush");
  });

  it("normalises whatever source it resolves", () => {
    expect(resolveCaller({ role: "agent", rawAgentId: "Claude Code" }).actor_id).toBe(
      "claude-code",
    );
  });
});

describe("resolveCaller — aliases (§4.4)", () => {
  const aliases = { "guybrush-hermes": "guybrush", bede: "guybrush" };

  it("applies aliases after normalisation", () => {
    const resolved = resolveCaller({
      role: "agent",
      rawAgentId: "Guybrush (Hermes)",
      aliases,
    });
    expect(resolved.actor_id).toBe("guybrush");
    expect(resolved.alias_applied).toBe("guybrush-hermes");
  });

  it("aliases a legacy id (bede → guybrush)", () => {
    expect(resolveCaller({ role: "agent", rawAgentId: "Bede", aliases }).actor_id).toBe("guybrush");
  });

  it("leaves non-aliased ids untouched (no alias_applied)", () => {
    const resolved = resolveCaller({ role: "agent", rawAgentId: "codex", aliases });
    expect(resolved.actor_id).toBe("codex");
    expect(resolved.alias_applied).toBeUndefined();
  });

  it("rejects alias chains (no recursive resolution)", () => {
    expect(() =>
      resolveCaller({
        role: "agent",
        rawAgentId: "a",
        aliases: { a: "b", b: "c" },
      }),
    ).toThrow(/chain/i);
  });

  it("rejects alias loops", () => {
    expect(() =>
      resolveCaller({
        role: "agent",
        rawAgentId: "a",
        aliases: { a: "b", b: "a" },
      }),
    ).toThrow(/chain/i);
  });
});

describe("resolveCaller — token binding & allowlist (§5.3)", () => {
  it("accepts when supplied id matches the token-bound id", () => {
    const resolved = resolveCaller({
      role: "agent",
      rawAgentId: "Guybrush",
      authenticatedAgentId: "guybrush",
    });
    expect(resolved.actor_id).toBe("guybrush");
  });

  it("rejects when supplied id differs from the token-bound id (impersonation)", () => {
    expect(() =>
      resolveCaller({
        role: "agent",
        rawAgentId: "codex",
        authenticatedAgentId: "guybrush",
      }),
    ).toThrow(/match|impersonat|mismatch/i);
  });

  it("rejects an injected id that differs from the token-bound id", () => {
    // A compromised wrapper still can't override a bound token.
    expect(() =>
      resolveCaller({
        role: "agent",
        injectedAgentId: "codex",
        authenticatedAgentId: "guybrush",
      }),
    ).toThrow(/match|impersonat|mismatch/i);
  });

  it("rejects an invalid token-bound id", () => {
    expect(() =>
      resolveCaller({ role: "agent", rawAgentId: "guybrush", authenticatedAgentId: "!!!" }),
    ).toThrow();
  });

  it("compares binding after aliasing", () => {
    const resolved = resolveCaller({
      role: "agent",
      rawAgentId: "Bede",
      authenticatedAgentId: "guybrush",
      aliases: { bede: "guybrush" },
    });
    expect(resolved.actor_id).toBe("guybrush");
  });

  it("rejects an id outside the token allowlist", () => {
    expect(() =>
      resolveCaller({
        role: "agent",
        rawAgentId: "codex",
        allowedAgentIds: ["guybrush", "claude-code"],
      }),
    ).toThrow(/allow/i);
  });

  it("accepts an id inside the token allowlist", () => {
    expect(
      resolveCaller({
        role: "agent",
        rawAgentId: "Claude Code",
        allowedAgentIds: ["guybrush", "claude-code"],
      }).actor_id,
    ).toBe("claude-code");
  });
});

describe("resolveCaller — missing identity (§5.3, §7.1)", () => {
  it("rejects a shared-token agent call with no supplied id (hard mode)", () => {
    expect(() => resolveCaller({ role: "agent" })).toThrow(/identit/i);
  });

  it("rejects an admin mutation with no audit actor id (hard mode)", () => {
    expect(() => resolveCaller({ role: "admin" })).toThrow(/identit/i);
  });

  it("falls back to the legacy sentinel in soft-migration mode", () => {
    const resolved = resolveCaller({ role: "agent", allowMissingDuringMigration: true });
    expect(resolved.actor_id).toBe(DEFAULT_AGENT_ID);
  });

  it("still prefers a real id over the soft-mode fallback", () => {
    const resolved = resolveCaller({
      role: "agent",
      rawAgentId: "codex",
      allowMissingDuringMigration: true,
    });
    expect(resolved.actor_id).toBe("codex");
  });
});

describe("reserved namespaces & role gating (§4.4, §6)", () => {
  it("lets a system actor use the system-* namespace", () => {
    const resolved = resolveCaller({
      role: "system",
      injectedAgentId: SYSTEM_ACTOR_IDS.memoryCurator,
    });
    expect(resolved.actor_id).toBe("system-memory-curator");
  });

  it("blocks an ordinary agent from claiming a system-* id", () => {
    expect(() => resolveCaller({ role: "agent", rawAgentId: "system-memory-curator" })).toThrow(
      /reserved|system/i,
    );
  });

  it("blocks an ordinary agent from aliasing into a reserved id", () => {
    expect(() =>
      resolveCaller({
        role: "agent",
        rawAgentId: "sneaky",
        aliases: { sneaky: "system-scheduler" },
      }),
    ).toThrow(/reserved|system/i);
  });

  it("lets an admin actor use the dashboard-* namespace", () => {
    expect(resolveCaller({ role: "admin", injectedAgentId: "dashboard-admin" }).actor_id).toBe(
      "dashboard-admin",
    );
  });

  it("blocks an ordinary agent from claiming a dashboard-* id", () => {
    expect(() => resolveCaller({ role: "agent", rawAgentId: "dashboard-admin" })).toThrow(
      /reserved|dashboard/i,
    );
  });

  it("blocks an ordinary agent from claiming the cli id", () => {
    expect(() => resolveCaller({ role: "agent", rawAgentId: "cli" })).toThrow(/reserved|cli/i);
  });
});

describe("actorKind classifier (§6)", () => {
  it("classifies by id namespace", () => {
    expect(actorKind("guybrush")).toBe("agent");
    expect(actorKind("system-memory-curator")).toBe("system");
    expect(actorKind("dashboard-admin")).toBe("admin");
    expect(actorKind("cli")).toBe("cli");
  });

  it("classifies any dashboard-* id as admin, not just dashboard-admin", () => {
    expect(actorKind("dashboard-jim")).toBe("admin");
  });
});

describe("isReservedId (§4.4)", () => {
  it("flags every reserved namespace", () => {
    expect(isReservedId("system-memory-curator")).toBe(true);
    expect(isReservedId("dashboard-admin")).toBe(true);
    expect(isReservedId("dashboard-jim")).toBe(true);
    expect(isReservedId("cli")).toBe(true);
  });

  it("leaves ordinary agent ids unreserved", () => {
    expect(isReservedId("guybrush")).toBe(false);
    expect(isReservedId("claude-code")).toBe(false);
  });
});
