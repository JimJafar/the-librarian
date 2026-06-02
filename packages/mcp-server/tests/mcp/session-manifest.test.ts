// session_manifest MCP tool (plan 036 Phase 5 / spec 035 §F6 server-side
// criterion). The session-start client hook consumes one endpoint that returns
// the working-style preamble + a bounded skills manifest (name + description).
// The working-style doc is sourced from the `working_style` setting (a small,
// reversible choice; the dashboard authors it later).

import fs from "node:fs";
import path from "node:path";
import { handleMcpPayload } from "@librarian/mcp-server";
import { describe, expect, it } from "vitest";
import { withStore } from "../../../../test/helpers.js";

type CallResult = { result: { content: { text: string }[] } };

const call = (store: unknown): Promise<unknown> =>
  handleMcpPayload(store as never, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "session_manifest", arguments: {} },
  });

describe("session_manifest MCP tool", () => {
  it("is advertised to agents", async () => {
    await withStore(async (store: unknown) => {
      const list = (await handleMcpPayload(store as never, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      })) as { result: { tools: { name: string }[] } };
      expect(list.result.tools.map((t) => t.name)).toContain("session_manifest");
    });
  });

  it("returns the working-style doc plus the skills manifest", async () => {
    await withStore(async (store: unknown, dataDir: string) => {
      (store as { setSetting: (k: string, v: string) => void }).setSetting(
        "working_style",
        "Be concise. Prefer bullet points.",
      );
      const dir = path.join(dataDir, "vault", "skills", "brewing");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "SKILL.md"),
        "---\nname: Brewing\ndescription: brew tea\n---\n\nbody\n",
      );

      const res = (await call(store)) as CallResult;
      const manifest = JSON.parse(res.result.content[0]!.text);
      expect(manifest.workingStyle).toBe("Be concise. Prefer bullet points.");
      expect(manifest.skills).toEqual([
        { slug: "brewing", name: "Brewing", description: "brew tea" },
      ]);
    });
  });

  it("returns an empty working-style and manifest when nothing is configured", async () => {
    await withStore(async (store: unknown) => {
      const res = (await call(store)) as CallResult;
      const manifest = JSON.parse(res.result.content[0]!.text);
      expect(manifest.workingStyle).toBe("");
      expect(manifest.skills).toEqual([]);
    });
  });

  it("lists multiple skills sorted by slug, independent of working-style", async () => {
    await withStore(async (store: unknown, dataDir: string) => {
      for (const slug of ["zebra", "alpha"]) {
        const dir = path.join(dataDir, "vault", "skills", slug);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, "SKILL.md"),
          `---\nname: ${slug}\ndescription: d-${slug}\n---\n\nbody\n`,
        );
      }
      const res = (await call(store)) as CallResult;
      const manifest = JSON.parse(res.result.content[0]!.text);
      expect(manifest.workingStyle).toBe(""); // independent of skills
      expect(manifest.skills.map((s: { slug: string }) => s.slug)).toEqual(["alpha", "zebra"]);
    });
  });
});
