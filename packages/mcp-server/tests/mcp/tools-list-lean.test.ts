// Wire-leanness guard (docs-site spec, K7 — inline+strip variant).
//
// Per-parameter human descriptions are authored INLINE on each tool's
// `inputSchema` so the docs generator has a single, drift-free source of
// truth. But agent context must stay lean: the `tools/list` payload an agent
// receives carries only the tool-level teaching description plus each param's
// name/type/required — never the per-param prose. `tools/list` therefore
// strips every property-level `description` before serialising. This test pins
// that contract: the wire is lean even though the source schemas are rich.

import { handleMcpPayload } from "@librarian/mcp-server";
import { describe, expect, it } from "vitest";
import { withStore } from "../../../../test/helpers.js";

/** Collect every `description` key anywhere inside a JSON-Schema value. */
function collectDescriptions(value: unknown, path: string, found: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectDescriptions(item, `${path}[${i}]`, found));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "description") found.push(path);
      collectDescriptions(child, `${path}.${key}`, found);
    }
  }
}

interface WireTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

async function listTools(store: Parameters<typeof handleMcpPayload>[0]): Promise<WireTool[]> {
  const res = (await handleMcpPayload(store, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  })) as { result: { tools: WireTool[] } };
  return res.result.tools;
}

describe("tools/list wire payload stays lean (K7 inline+strip)", () => {
  it("ships no per-parameter description to agents", async () => {
    await withStore(async (store) => {
      const tools = await listTools(store);
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        const leaked: string[] = [];
        collectDescriptions(tool.inputSchema, `${tool.name}.inputSchema`, leaked);
        expect(
          leaked,
          `inputSchema description(s) leaked to the wire: ${leaked.join(", ")}`,
        ).toEqual([]);
      }
    });
  });

  it("still ships the tool-level teaching description (that surface is NOT stripped)", async () => {
    await withStore(async (store) => {
      const tools = await listTools(store);
      for (const tool of tools) {
        expect(tool.description, `${tool.name} lost its tool-level description`).toBeTruthy();
      }
    });
  });

  it("preserves every parameter's name, type, and required-ness on the wire", async () => {
    await withStore(async (store) => {
      const tools = await listTools(store);
      const search = tools.find((tool) => tool.name === "search_references");
      expect(search).toBeDefined();
      const schema = search!.inputSchema as {
        properties?: Record<string, { type?: unknown }>;
        required?: string[];
      };
      // The param shape survives the strip — only its prose is removed.
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["limit", "query"]);
      expect(schema.required).toContain("query");
      expect(schema.properties?.query?.type).toBe("string");
    });
  });
});
