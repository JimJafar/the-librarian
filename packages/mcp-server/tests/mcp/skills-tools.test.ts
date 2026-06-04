// MCP skills tools (plan 036 Phase 5 / spec 035 §F7). get_skill + find_skills
// dispatch through handleMcpPayload over a vault-based skill store. The markdown
// store serves skills authored under <dataDir>/vault/skills/.

import fs from "node:fs";
import path from "node:path";
import { handleMcpPayload } from "@librarian/mcp-server";
import { describe, expect, it } from "vitest";
import { withStore } from "../../../../test/helpers.js";

type CallResult = { result: { content: { text: string }[] } };

function writeSkill(dataDir: string, slug: string, name: string, description: string): void {
  const dir = path.join(dataDir, "vault", "skills", slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nbody for ${slug}\n`,
  );
}

const call = (store: unknown, name: string, args: Record<string, unknown>): Promise<unknown> =>
  handleMcpPayload(store as never, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });

describe("skills MCP tools", () => {
  it("advertises get_skill and find_skills to agents", async () => {
    await withStore(async (store: unknown) => {
      const list = (await handleMcpPayload(store as never, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      })) as { result: { tools: { name: string }[] } };
      const names = list.result.tools.map((t) => t.name);
      expect(names).toContain("get_skill");
      expect(names).toContain("find_skills");
    });
  });

  it("get_skill returns the full document for a known slug", async () => {
    await withStore(async (store: unknown, dataDir: string) => {
      writeSkill(dataDir, "brewing", "Brewing", "how to brew tea");
      const res = (await call(store, "get_skill", { slug: "brewing" })) as CallResult;
      const skill = JSON.parse(res.result.content[0]!.text).skill;
      expect(skill).toMatchObject({ slug: "brewing", name: "Brewing" });
      expect(skill.body).toContain("body for brewing");
    });
  });

  it("get_skill returns { skill: null } for an unknown slug (fail-soft)", async () => {
    await withStore(async (store: unknown) => {
      const res = (await call(store, "get_skill", { slug: "missing" })) as CallResult;
      expect(JSON.parse(res.result.content[0]!.text).skill).toBeNull();
    });
  });

  it("find_skills ranks the matching skill first", async () => {
    await withStore(async (store: unknown, dataDir: string) => {
      writeSkill(dataDir, "brewing", "Tea Brewing", "steeping loose leaf tea");
      writeSkill(dataDir, "sailing", "Sailing", "navigating boats across water");
      const res = (await call(store, "find_skills", { query: "tea" })) as CallResult;
      const hits = JSON.parse(res.result.content[0]!.text).skills;
      expect(hits[0].slug).toBe("brewing");
    });
  });

  it("find_skills rejects an empty/whitespace query (fail-soft)", async () => {
    await withStore(async (store: unknown) => {
      const res = (await call(store, "find_skills", { query: "   " })) as CallResult;
      expect(res.result.content[0]!.text).toContain("rejected");
    });
  });

  it("find_skills tolerates an out-of-range limit (clamped, never errors)", async () => {
    await withStore(async (store: unknown, dataDir: string) => {
      writeSkill(dataDir, "brewing", "Tea Brewing", "steeping loose leaf tea");
      // a negative limit must not drop the match (old slice(0,-1) footgun)
      const res = (await call(store, "find_skills", { query: "tea", limit: -1 })) as CallResult;
      const hits = JSON.parse(res.result.content[0]!.text).skills;
      expect(hits.map((h: { slug: string }) => h.slug)).toContain("brewing");
    });
  });

  it("get_skill returns { skill: null } for a path-traversal slug (never throws)", async () => {
    await withStore(async (store: unknown) => {
      const res = (await call(store, "get_skill", { slug: "../../secret" })) as CallResult;
      expect(JSON.parse(res.result.content[0]!.text).skill).toBeNull();
    });
  });
});
