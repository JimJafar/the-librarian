// Tool-registry contract — the guardrail against agent-facing MCP surface
// drift (spec 047 / ADR 0006). The set of registered tool names is a contract
// the harness plugins depend on; this test pins it exactly, so adding or
// removing a tool fails here until the change is deliberate and the expected
// set is updated in the same commit.
//
// Imported from the built artifact: this package's vitest config externalizes
// packages/mcp-server/{src,dist} to Node's loader, which can't parse .ts — the
// same reason the other internal-module tests exercise dist/.
import { describe, expect, it } from "vitest";
import { toolsByName } from "../../dist/mcp/tools/index.js";

// The agent-facing tool surface (rethink spec §5.1): the 7 memory/handoff
// verbs plus the 3 conv_state tools = 10 names (conv_state goes in T2). The
// skills subsystem (`list_skills` / `get_skill`) was deleted in rethink T1.
// Kept sorted so a diff reads cleanly when the contract intentionally changes.
const EXPECTED_TOOL_NAMES = [
  "claim_handoff",
  "conv_state_clear",
  "conv_state_get",
  "conv_state_upsert",
  "flag_memory",
  "list_handoffs",
  "recall",
  "remember",
  "search_references",
  "store_handoff",
];

// Removed in PR-4 (ADR 0006) + rethink T1 (skills). Pinned as a positive
// absence assertion so a re-add fails here until the contract is deliberately
// changed.
const REMOVED_TOOL_NAMES = [
  "start_context",
  "propose_memory",
  "update_memory",
  "archive_memory",
  "list_proposals",
  "approve_proposal",
  // rethink T1 — the skills subsystem is deleted entirely.
  "list_skills",
  "get_skill",
];

describe("MCP tool registry contract", () => {
  it("registers exactly the expected set of tool names", () => {
    const actual = [...toolsByName.keys()].sort();
    expect(actual).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it("registers exactly 10 tools", () => {
    expect(toolsByName.size).toBe(EXPECTED_TOOL_NAMES.length);
    expect(EXPECTED_TOOL_NAMES).toHaveLength(10);
  });

  it("no longer exposes the retired admin/skills verbs", () => {
    for (const name of REMOVED_TOOL_NAMES) {
      expect(toolsByName.has(name)).toBe(false);
    }
  });

  it("exposes flag_memory and no longer exposes verify_memory", () => {
    expect(toolsByName.has("flag_memory")).toBe(true);
    expect(toolsByName.has("verify_memory")).toBe(false);
  });

  it("no longer exposes the retired skills/session discovery verbs", () => {
    expect(toolsByName.has("list_skills")).toBe(false);
    expect(toolsByName.has("get_skill")).toBe(false);
    expect(toolsByName.has("find_skills")).toBe(false);
    expect(toolsByName.has("session_manifest")).toBe(false);
  });
});
