// MCP skills tools (ADR 0006). list_skills + get_skill dispatch through
// handleMcpPayload over a vault-based skill store. The markdown store serves
// skills authored under <dataDir>/vault/skills/. (`find_skills` was retired —
// list_skills + the model's own judgment replaces ranked search.)

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
  it("advertises list_skills and get_skill to agents (and not the retired find_skills)", async () => {
    await withStore(async (store: unknown) => {
      const list = (await handleMcpPayload(store as never, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      })) as { result: { tools: { name: string }[] } };
      const names = list.result.tools.map((t) => t.name);
      expect(names).toContain("list_skills");
      expect(names).toContain("get_skill");
      expect(names).not.toContain("find_skills");
    });
  });

  it("list_skills returns the bounded manifest (slug, name, description), sorted by slug", async () => {
    await withStore(async (store: unknown, dataDir: string) => {
      writeSkill(dataDir, "zebra", "Zebra", "stripes");
      writeSkill(dataDir, "alpha", "Alpha", "first");
      const res = (await call(store, "list_skills", {})) as CallResult;
      const skills = JSON.parse(res.result.content[0]!.text).skills;
      expect(skills).toEqual([
        { slug: "alpha", name: "Alpha", description: "first" },
        { slug: "zebra", name: "Zebra", description: "stripes" },
      ]);
    });
  });

  it("list_skills returns an empty manifest when no skills are authored", async () => {
    await withStore(async (store: unknown) => {
      const res = (await call(store, "list_skills", {})) as CallResult;
      expect(JSON.parse(res.result.content[0]!.text).skills).toEqual([]);
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

  it("get_skill returns { skill: null } for a path-traversal slug (never throws)", async () => {
    await withStore(async (store: unknown) => {
      const res = (await call(store, "get_skill", { slug: "../../secret" })) as CallResult;
      expect(JSON.parse(res.result.content[0]!.text).skill).toBeNull();
    });
  });
});
