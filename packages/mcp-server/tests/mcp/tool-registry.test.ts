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

// The agent-facing tool surface after this PR (ADR 0006, in progress): the
// prior 19 minus `find_skills` and `session_manifest`, plus `list_skills` — now
// 18 names. Kept sorted so a diff reads cleanly when the contract
// intentionally changes.
const EXPECTED_TOOL_NAMES = [
  "approve_proposal",
  "archive_memory",
  "claim_handoff",
  "conv_state_clear",
  "conv_state_get",
  "conv_state_upsert",
  "flag_memory",
  "get_skill",
  "list_handoffs",
  "list_proposals",
  "list_skills",
  "propose_memory",
  "recall",
  "remember",
  "search_references",
  "start_context",
  "store_handoff",
  "update_memory",
];

describe("MCP tool registry contract", () => {
  it("registers exactly the expected set of tool names", () => {
    const actual = [...toolsByName.keys()].sort();
    expect(actual).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it("registers exactly 18 tools", () => {
    expect(toolsByName.size).toBe(EXPECTED_TOOL_NAMES.length);
    expect(EXPECTED_TOOL_NAMES).toHaveLength(18);
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
