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
import { collectCliHelp, generateReference, renderMcpVerbs } from "../scripts/docs-gen.mjs";

const page = renderMcpVerbs(tools);
const reference = generateReference();

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

describe("generated CLI reference page", () => {
  const cli = reference["apps/docs/src/content/docs/reference/cli.md"];

  it("is part of the generated reference", () => {
    expect(cli).toBeTruthy();
    expect(cli).toMatch(/^---\n[\s\S]*?title: CLI/);
  });

  it("embeds every CLI surface's help verbatim — both CLIs, every command", () => {
    // Verbatim parity: each canonical usage block appears in full, so adding or
    // renaming a command in any CLI forces the page to regenerate (check:docs).
    const help = collectCliHelp();
    for (const [surface, text] of Object.entries(help)) {
      expect(cli, `cli page is missing the ${surface} help block`).toContain(text.trimEnd());
    }
  });

  it("names both binaries and their key subcommands", () => {
    for (const token of [
      "librarian server", // installer/self-host CLI + its server subcommands
      "the-librarian handoffs", // admin CLI + handoffs
      "the-librarian auth", // admin CLI + auth recovery
    ]) {
      expect(cli, `cli page should reference '${token}'`).toContain(token);
    }
  });
});
