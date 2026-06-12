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

// The final agent-facing tool surface (ADR 0006): the 9 memory/handoff/skill
// verbs plus the 3 conv_state tools = 12 names. PR-4 removed the six remaining
// redundant/admin wrappers (`start_context`, `propose_memory`, `update_memory`,
// `archive_memory`, `list_proposals`, `approve_proposal`) — their admin
// capabilities remain reachable over the dashboard tRPC surface, only the agent
// tool wrappers are gone. Kept sorted so a diff reads cleanly when the contract
// intentionally changes.
const EXPECTED_TOOL_NAMES = [
  "claim_handoff",
  "conv_state_clear",
  "conv_state_get",
  "conv_state_upsert",
  "flag_memory",
  "get_skill",
  "list_handoffs",
  "list_skills",
  "recall",
  "remember",
  "search_references",
  "store_handoff",
];

// Removed in PR-4 (ADR 0006). Pinned as a positive absence assertion so a
// re-add fails here until the contract is deliberately changed.
const REMOVED_TOOL_NAMES = [
  "start_context",
  "propose_memory",
  "update_memory",
  "archive_memory",
  "list_proposals",
  "approve_proposal",
];

describe("MCP tool registry contract", () => {
  it("registers exactly the expected set of tool names", () => {
    const actual = [...toolsByName.keys()].sort();
    expect(actual).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it("registers exactly 12 tools", () => {
    expect(toolsByName.size).toBe(EXPECTED_TOOL_NAMES.length);
    expect(EXPECTED_TOOL_NAMES).toHaveLength(12);
  });

  it("no longer exposes the six redundant/admin verbs removed in PR-4", () => {
    for (const name of REMOVED_TOOL_NAMES) {
      expect(toolsByName.has(name)).toBe(false);
    }
  });

  it("exposes flag_memory and no longer exposes verify_memory", () => {
    expect(toolsByName.has("flag_memory")).toBe(true);
    expect(toolsByName.has("verify_memory")).toBe(false);
  });

  it("exposes list_skills and no longer exposes find_skills or session_manifest", () => {
    expect(toolsByName.has("list_skills")).toBe(true);
    expect(toolsByName.has("find_skills")).toBe(false);
    expect(toolsByName.has("session_manifest")).toBe(false);
  });
});
