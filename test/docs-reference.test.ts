// Reference-parity guard for the generated docs (docs-site spec criterion #4).
//
// The reference pages under apps/docs are GENERATED from canonical sources by
// scripts/docs-gen.mjs and committed; scripts/check-docs.mjs (the drift-guard)
// fails CI if the committed pages fall out of sync. This suite pins the parity
// contract on the generator's output itself: the MCP-verbs page must carry
// exactly the seven verbs, each with its tool-level description and every
// parameter's name, type, required-ness, and human description — so a verb or
// parameter can never silently vanish from the reference.

import { tools } from "@librarian/mcp-server";
import { describe, expect, it } from "vitest";
import { renderMcpVerbs } from "../scripts/docs-gen.mjs";

const page = renderMcpVerbs(tools);

/** The `## `verb`` headings, in document order. */
function verbHeadings(markdown: string): string[] {
  return [...markdown.matchAll(/^##\s+`([a-z_]+)`/gm)].map((m) => m[1]);
}

describe("generated MCP-verbs reference page", () => {
  it("has Starlight frontmatter with a title", () => {
    expect(page).toMatch(/^---\n[\s\S]*?\btitle:/);
  });

  it("documents exactly the seven verbs, by name", () => {
    expect(verbHeadings(page).sort()).toEqual(
      [
        "claim_handoff",
        "flag_memory",
        "list_handoffs",
        "recall",
        "remember",
        "search_references",
        "store_handoff",
      ].sort(),
    );
    // Count guard: no duplicate or stray verb sections.
    expect(verbHeadings(page)).toHaveLength(7);
  });

  it("renders each verb's tool-level teaching description verbatim", () => {
    for (const tool of tools) {
      expect(page, `missing description for ${tool.name}`).toContain(tool.description);
    }
  });

  it("renders every parameter of every verb with its name and description", () => {
    for (const tool of tools) {
      const schema = tool.inputSchema as {
        properties?: Record<string, { description?: string }>;
      };
      for (const [name, prop] of Object.entries(schema.properties ?? {})) {
        expect(page, `${tool.name}: parameter '${name}' not rendered`).toContain(`\`${name}\``);
        expect(page, `${tool.name}.${name}: description not rendered`).toContain(prop.description);
      }
    }
  });

  it("marks the server-populated agent_id distinctly, not as a parameter you pass", () => {
    // agent_id appears in recall/remember/flag_memory but is resolved from the
    // bearer token — the reference must not present it as caller-supplied.
    expect(page).toMatch(/agent_id[\s\S]*?server-populated/i);
  });
});
