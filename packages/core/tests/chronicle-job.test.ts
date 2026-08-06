import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addProvider,
  createLibrarianStore,
  resolveSecretKey,
  runChronicleTick,
  runScheduledChronicle,
  writeChronicleConfig,
  writeConsumerConfig,
  type LibrarianStore,
  type LlmClient,
  type Shelf,
  type VaultRouter,
} from "@librarian/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const dirs: string[] = [];
const stores: LibrarianStore[] = [];
const KEY = resolveSecretKey("0123456789abcdef".repeat(4));

function boot(vaultRouter?: VaultRouter): { store: LibrarianStore; dataDir: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-chronicle-job-"));
  dirs.push(dataDir);
  const store = createLibrarianStore({
    dataDir,
    secretKey: KEY,
    ...(vaultRouter ? { vaultRouter } : {}),
  });
  stores.push(store);
  return { store, dataDir };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("runChronicleTick", () => {
  it("Run now writes a partial digest and records a skipped narrator without a provider", async () => {
    const { store } = boot();
    const now = new Date(2026, 6, 29, 12, 0);

    const result = await runChronicleTick({
      store,
      now,
      trigger: "manual",
      allowDisabled: true,
    });

    expect(result).toMatchObject({
      ran: true,
      attempted: 1,
      completed: 1,
      failed: 0,
      digestOnly: 1,
      generated: 0,
      period: { isoWeek: "2026-W31", partial: true },
    });
    const file = store.vaultFiles.readFile("references/chronicle/2026-W31.md");
    expect(file.raw).toContain("# Chronicle: 2026-W31 (partial — through 2026-07-29)");
    expect(store.listChronicleRuns()[0]).toMatchObject({
      status: "completed",
      trigger: "manual",
      narrative: "skipped",
      path: "references/chronicle/2026-W31.md",
    });
  });

  it("uses the Chronicle consumer once and records narration usage", async () => {
    const { store } = boot();
    const provider = addProvider(store, {
      name: "Narrator",
      endpoint: "https://narrator.example/v1",
      token: "dummy-narrator-token",
    });
    writeConsumerConfig(store, "chronicle", { providerId: provider.id, model: "story-model" });
    const llm: LlmClient = {
      complete: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          headline: "The evidence held together.",
          narrative_md: "A narrated account grounded in the weekly facts.",
          blog_seeds: [],
        }),
        model: "story-model",
        usage: { promptTokens: 80, completionTokens: 20, totalTokens: 100 },
      }),
    };
    const buildClient = vi.fn(() => llm);

    const result = await runChronicleTick({
      store,
      now: new Date(2026, 6, 29, 12, 0),
      trigger: "manual",
      allowDisabled: true,
      buildClient,
    });

    expect(result).toMatchObject({ ran: true, generated: 1, digestOnly: 0 });
    expect(buildClient).toHaveBeenCalledTimes(1);
    expect(store.listChronicleRuns()[0]).toMatchObject({
      narrative: "generated",
      model_provider: provider.id,
      model_name: "story-model",
      usage_input_tokens: 80,
      usage_output_tokens: 20,
    });
    expect(store.vaultFiles.readFile("references/chronicle/2026-W31.md").raw).toContain(
      "The evidence held together.",
    );
  });

  it("writes one Chronicle per writable system shelf and omits vault-global run aggregates", async () => {
    const writable: Shelf = { id: "team-a", label: "Team A", prefix: "teams/a/", writable: true };
    const readOnly: Shelf = { id: "team-b", label: "Team B", prefix: "teams/b/", writable: false };
    const shelves = [writable, readOnly] as const;
    const router: VaultRouter = { shelves: () => shelves, writeTarget: () => writable };
    const { store, dataDir } = boot(router);

    const result = await runChronicleTick({
      store,
      now: new Date(2026, 6, 29, 12, 0),
      trigger: "manual",
      allowDisabled: true,
    });

    expect(result).toMatchObject({ ran: true, attempted: 1, completed: 1 });
    const rel = "teams/a/references/chronicle/2026-W31.md";
    expect(fs.existsSync(path.join(dataDir, "vault", rel))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "vault", "teams/b"))).toBe(false);
    expect(fs.readFileSync(path.join(dataDir, "vault", rel), "utf8")).toContain(
      "Vault-global intake and grooming aggregates were omitted for multi-shelf Chronicle output.",
    );
  });
});

describe("runScheduledChronicle", () => {
  it("self-gates, writes the previous completed week when due, and advances only on success", async () => {
    const { store } = boot();
    const now = new Date(2026, 7, 3, 8, 0);
    expect(await runScheduledChronicle({ store, now })).toEqual({ ran: false, reason: "disabled" });

    writeChronicleConfig(store, { enabled: true });
    const result = await runScheduledChronicle({ store, now });
    expect(result).toMatchObject({
      ran: true,
      failed: 0,
      period: { isoWeek: "2026-W31", partial: false },
    });
    expect(store.getSetting("chronicle.last_run_at")).toBe(now.toISOString());
    expect(store.vaultFiles.readFile("references/chronicle/2026-W31.md").raw).not.toContain(
      "partial —",
    );
    expect(await runScheduledChronicle({ store, now: new Date(2026, 7, 3, 9, 0) })).toEqual({
      ran: false,
      reason: "not_due",
    });
  });
});
