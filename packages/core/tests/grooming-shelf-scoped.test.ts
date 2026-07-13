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
  type Principal,
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

  it("grooms a READ-ONLY shelf — its writes land under the shelf (system pipelines are ungated, review A1)", async () => {
    // A router that grooms a member shelf (writable) + a READ-ONLY team shelf. `writable` gates
    // PRINCIPAL-attributed writes only (vault-router contract); grooming is a SYSTEM pipeline scoped to
    // the shelf being processed (spec §4), so it must groom the read-only shelf fine and land its
    // writes UNDER it. Pre-fix this threw ShelfNotWritableError per apply, swallowed into `errored`.
    const roTeam: Shelf = { id: "team", prefix: "team/", writable: false, label: "Team library" };
    const router: VaultRouter = { shelves: () => [A, roTeam], writeTarget: () => A };
    store = createLibrarianStore({ dataDir, secretKey: KEY, vaultRouter: router });
    store
      .forShelf(A)
      .createMemory({ title: "ALPHA-SEED", body: "alpha body", agent_id: "sarah" }, {});
    // Seed the read-only team shelf via a WRITABLE view of the same prefix (out-of-band seeding, as
    // the Teams e2e does) — the per-call gate (review A2) lets this coexist with the read-only groom.
    store
      .forShelf({ id: "team", prefix: "team/", writable: true })
      .createMemory({ title: "BETA-SEED", body: "beta body", agent_id: "sarah" }, {});
    configureGrooming();

    const { client } = capturingClient();
    const result = await runGroomingTick({ store, buildClient: () => client });

    expect(result.ran).toBe(true);
    if (result.ran) {
      expect(result.summary.ran).toBe(2); // both shelves groomed
      expect(result.summary.errored).toBe(0); // the read-only groom did NOT error (the A1 fix)
    }
    // The curator's GROOM-CREATED memory landed UNDER team/ despite writable:false.
    expect(memoryFiles("team")).toHaveLength(2);
    expect(readMemories("team").some((m) => /^title: GROOM-CREATED$/m.test(m))).toBe(true);
    // Nothing leaked to the vault root.
    expect(fs.existsSync(path.join(vaultDir, "memories"))).toBe(false);
  });

  it("order-independence: a prior READ-ONLY recall of a prefix does not neuter a later groom of it (review A2)", async () => {
    // Materialise team/ READ-ONLY via a recall FIRST, then groom it — the A2 defect baked the
    // read-only gate at first materialisation, so this groom would have refused every write.
    const roTeam: Shelf = { id: "team", prefix: "team/", writable: false };
    const router: VaultRouter = {
      shelves: (_p, op) => (op === "write" ? [A] : [A, roTeam]),
      writeTarget: () => A,
    };
    store = createLibrarianStore({ dataDir, secretKey: KEY, vaultRouter: router });
    store
      .forShelf(A)
      .createMemory({ title: "ALPHA-SEED", body: "alpha body", agent_id: "sarah" }, {});
    store
      .forShelf({ id: "team", prefix: "team/", writable: true })
      .createMemory({ title: "BETA-SEED", body: "beta body", agent_id: "sarah" }, {});
    // Read-only recall FIRST — materialises the team/ core through a read-only view.
    const principal: Principal = { kind: "agent", actorId: "sarah", roles: ["agent"] };
    await store.recallForPrincipal(principal, { query: "body" });

    configureGrooming();
    const { client } = capturingClient();
    const result = await runGroomingTick({ store, buildClient: () => client });

    expect(result.ran).toBe(true);
    if (result.ran) expect(result.summary.errored).toBe(0);
    expect(readMemories("team").some((m) => /^title: GROOM-CREATED$/m.test(m))).toBe(true);
  });

  it("ADR 0005 cap applies PER SHELF: each shelf's pass caps its own slice's evidence (spec 062 SC 7 / review G5)", async () => {
    store = createLibrarianStore({ dataDir, secretKey: KEY, vaultRouter: twoShelfRouter });
    // Seed THREE memories forming ONE slice on EACH shelf (same visibility/scope/project), so the cap
    // bites within a single slice per shelf rather than degenerating into one memory per run.
    const seedSlice = (shelf: Shelf, marker: string): void => {
      for (const n of ["ALPHA", "BETA", "GAMMA"]) {
        store!.forShelf(shelf).createMemory(
          {
            agent_id: "sarah",
            title: `${marker}-${n}`,
            body: "b",
            category: "lessons",
            visibility: "common",
            scope: "project",
            project_key: "proj-x",
            confidence: "working",
          },
          {},
        );
      }
    };
    seedSlice(A, "AMEM");
    seedSlice(B, "BMEM");
    configureGrooming();

    const { client, prompts } = capturingClient();
    // Cap of 2 over each shelf's 3-memory slice → exactly TWO of each shelf's memories reach that
    // shelf's curator prompt (ADR 0005 budget is per shelf run, spec 062 SC 7).
    const result = await runGroomingTick({
      store,
      buildClient: () => client,
      caps: { maxMemories: 2 },
    });

    expect(result.ran).toBe(true);
    expect(prompts).toHaveLength(2);
    const aSeen = ["AMEM-ALPHA", "AMEM-BETA", "AMEM-GAMMA"].filter((m) => prompts[0]!.includes(m));
    const bSeen = ["BMEM-ALPHA", "BMEM-BETA", "BMEM-GAMMA"].filter((m) => prompts[1]!.includes(m));
    expect(aSeen).toHaveLength(2); // shelf A's pass received the cap
    expect(bSeen).toHaveLength(2); // shelf B's pass received the SAME cap
    // Read isolation still holds — A's prompt never saw B's memories.
    expect(prompts[0]).not.toContain("BMEM-");
    expect(prompts[1]).not.toContain("AMEM-");
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
