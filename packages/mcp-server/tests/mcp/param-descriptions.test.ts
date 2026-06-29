// Param-description coverage guard (docs-site spec, K7 — inline+strip variant).
//
// The docs reference (success criterion #4) shows every parameter's human
// "meaning". That prose has a single source of truth: an inline `description`
// on each property of the tool's `inputSchema`. The wire stays lean because
// `tools/list` strips these (see tools-list-lean.test.ts) — so the descriptions
// are docs-only and cost an agent nothing.
//
// This guard is the drift defence: add a parameter to a schema without
// documenting it, and CI fails here naming the orphan, before the reference can
// ship with a blank cell. It replaces the spec's original sidecar↔schema parity
// assertion — with inline descriptions there is no separate sidecar to drift
// against; the prose lives on the param itself.

import { tools } from "@librarian/mcp-server";
import { describe, expect, it } from "vitest";

interface SchemaProperty {
  description?: unknown;
  type?: unknown;
}
interface ObjectSchema {
  properties?: Record<string, SchemaProperty>;
}

describe("every MCP tool parameter carries an inline human description", () => {
  for (const tool of tools) {
    const schema = tool.inputSchema as ObjectSchema;
    const params = Object.entries(schema.properties ?? {});

    describe(tool.name, () => {
      it("declares at least one parameter", () => {
        expect(params.length).toBeGreaterThan(0);
      });

      for (const [name, prop] of params) {
        it(`documents '${name}'`, () => {
          const ok = typeof prop.description === "string" && prop.description.trim().length > 0;
          expect(
            ok,
            `${tool.name}.${name} has no inline description — the docs reference has nothing to show for it. ` +
              `Add a 'description' to this property in its tool's inputSchema.`,
          ).toBe(true);
        });
      }
    });
  }
});
