// Per-shelf grooming via scoped handles (spec 062 T6 — SC 7). A two-shelf router grooms EACH
// shelf sequentially against its OWN scoped store handle: each pass reads only that shelf's
// memories (proven from the prompt the curator LLM sees), and each pass's proposals/writes land
// BENEATH that shelf's prefix only (proven from the files). A run on shelf A never reads or writes
// shelf B. The DEFAULT router grooms exactly ONE shelf — today's single run (byte-inert).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  type LlmClient,
  type LlmCompletionRequest,
  type Shelf,
  type VaultRouter,
  addProvider,
  createLibrarianStore,
  resolveSecretKey,
  runGroomingTick,
  writeConsumerConfig,
  writeGroomingConfig,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const KEY = resolveSecretKey("0123456789abcdef".repeat(4));

// Two writable shelves, both in the groom set (a router that grooms a member + team shelf).
const A: Shelf = { id: "members-x", prefix: "members/x/", writable: true, label: "Sarah's shelf" };
const B: Shelf = { id: "team", prefix: "team/", writable: true };
const twoShelfRouter: VaultRouter = { shelves: () => [A, B], writeTarget: () => A };

let store: LibrarianStore | null = null;
let dataDir = "";
let vaultDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-groom-shelf-"));
  vaultDir = path.join(dataDir, "vault");
});
afterEach(() => {
  try {
    store?.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  store = null;
  dataDir = "";
  vaultDir = "";
});

// The curator's canned output: a high-confidence create, so every pass AUTO-APPLIES a new
// "GROOM-CREATED" memory into the shelf it is grooming (no target id needed → shelf-agnostic op).
const CREATE_OP = JSON.stringify({
  operations: [
    {
      type: "create",
      memory: { title: "GROOM-CREATED", body: "curator authored fact", visibility: "common" },
      rationale: "durable new fact",
      confidence: 0.95,
    },
  ],
});

/** A curator LLM that records every prompt it is shown and returns the create op. */
function capturingClient(): { client: LlmClient; prompts: string[] } {
  const prompts: string[] = [];
  return {
    client: {
      complete: async (req: LlmCompletionRequest) => {
        prompts.push(req.messages.map((m) => m.content).join("\n"));
        return { content: CREATE_OP, model: "gpt-x", usage: null };
      },
    },
    prompts,
  };
}

function configureGrooming(): void {
  writeGroomingConfig(store!, { enabled: true });
  const provider = addProvider(store!, {
    name: "default",
    endpoint: "https://api.example.com/v1",
    token: "dummy-decrypted-token",
  });
  writeConsumerConfig(store!, "grooming", { providerId: provider.id, model: "gpt-x" });
}

function memoryFiles(prefix: string): string[] {
  const dir = path.join(vaultDir, prefix, "memories");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
}
function readMemories(prefix: string): string[] {
  const dir = path.join(vaultDir, prefix, "memories");
  return memoryFiles(prefix).map((f) => fs.readFileSync(path.join(dir, f), "utf8"));
}

describe("grooming per shelf via scoped handles (spec 062 SC 7)", () => {
  it("grooms both shelves sequentially; each pass reads + writes ONLY its own shelf", async () => {
    store = createLibrarianStore({ dataDir, secretKey: KEY, vaultRouter: twoShelfRouter });
    // Seed each shelf with a distinctly-titled active memory so its slice exists AND the prompt is
    // identifiable. The seeds are scoped writes through the shelf handle.
    store
      .forShelf(A)
      .createMemory({ title: "ALPHA-SEED", body: "alpha body", agent_id: "sarah" }, {});
    store
      .forShelf(B)
      .createMemory({ title: "BETA-SEED", body: "beta body", agent_id: "sarah" }, {});
    configureGrooming();

    const { client, prompts } = capturingClient();
    const result = await runGroomingTick({ store, buildClient: () => client });

    expect(result.ran).toBe(true);
    // Two shelves groomed → two runs attempted, one per shelf (the summary sums both passes).
    if (result.ran) {
      expect(result.summary.due).toBe(2);
      expect(result.summary.ran).toBe(2);
    }

    // READ ISOLATION — passes run in router order [A, B]. Shelf A's prompt saw ALPHA-SEED and NEVER
    // BETA-SEED; shelf B's saw BETA-SEED and NEVER ALPHA-SEED. This is the "a run on A never reads B"
    // proof, straight from the evidence the curator was given.
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("ALPHA-SEED");
    expect(prompts[0]).not.toContain("BETA-SEED");
    expect(prompts[1]).toContain("BETA-SEED");
    expect(prompts[1]).not.toContain("ALPHA-SEED");

    // WRITE ISOLATION — each shelf now holds its seed + its OWN curator-created memory, both beneath
    // its own prefix. Neither shelf's GROOM-CREATED leaked into the other or to the vault root.
    expect(memoryFiles("members/x")).toHaveLength(2);
    expect(memoryFiles("team")).toHaveLength(2);
    const aTitles = readMemories("members/x");
    const bTitles = readMemories("team");
    expect(aTitles.some((m) => /^title: ALPHA-SEED$/m.test(m))).toBe(true);
    expect(aTitles.some((m) => /^title: GROOM-CREATED$/m.test(m))).toBe(true);
    expect(bTitles.some((m) => /^title: BETA-SEED$/m.test(m))).toBe(true);
    expect(bTitles.some((m) => /^title: GROOM-CREATED$/m.test(m))).toBe(true);
    // The curator-authored memory is attributed to the grooming system actor.
    const aCreated = aTitles.find((m) => /^title: GROOM-CREATED$/m.test(m))!;
    expect(aCreated).toMatch(/^agent_id: system-memory-curator$/m);

    // No top-level (vault-root) memories/ — every write was shelf-scoped.
    expect(fs.existsSync(path.join(vaultDir, "memories"))).toBe(false);
  });

  it("default router grooms exactly ONE shelf — today's single run (byte-inert)", async () => {
    store = createLibrarianStore({ dataDir, secretKey: KEY }); // default router
    store.createMemory({ title: "SOLO-SEED", body: "solo body", agent_id: "sarah" });
    configureGrooming();

    const { client, prompts } = capturingClient();
    const result = await runGroomingTick({ store, buildClient: () => client });

    expect(result.ran).toBe(true);
    if (result.ran) {
      expect(result.summary.due).toBe(1); // ONE shelf iteration
      expect(result.summary.ran).toBe(1);
    }
    expect(prompts).toHaveLength(1); // the curator LLM was consulted exactly once
    // The write landed at the vault root (top-level memories/), not under any prefix.
    expect(memoryFiles("")).toHaveLength(2); // SOLO-SEED + GROOM-CREATED
  });
});
