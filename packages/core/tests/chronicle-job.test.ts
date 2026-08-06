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

  it("writes one Chronicle per writable system shelf with its attributed run aggregates", async () => {
    const writable: Shelf = { id: "team-a", label: "Team A", prefix: "teams/a/", writable: true };
    const readOnly: Shelf = { id: "team-b", label: "Team B", prefix: "teams/b/", writable: false };
    const shelves = [writable, readOnly] as const;
    const router: VaultRouter = { shelves: () => shelves, writeTarget: () => writable };
    const { store, dataDir } = boot(router);
    vi.spyOn(store, "listCurationRuns").mockImplementation((input = {}) =>
      input.shelfId === "team-a" && !input.before
        ? [
            {
              id: "cur-team-a",
              status: "completed",
              trigger: "schedule",
              shelf_id: "team-a",
              shelf_label: "Team A",
              mode: "apply",
              project_key: null,
              input_hash: "hash",
              input_memory_ids: [],
              model_provider: "provider-a",
              model_name: "model-a",
              usage_input_tokens: 12,
              usage_output_tokens: 3,
              summary: null,
              error: null,
              created_at: "2026-07-29T10:00:00.000Z",
              started_at: "2026-07-29T10:00:00.000Z",
              completed_at: "2026-07-29T10:00:01.000Z",
            },
          ]
        : [],
    );

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
    const content = fs.readFileSync(path.join(dataDir, "vault", rel), "utf8");
    expect(content).toContain("Grooming status: completed | 1");
    expect(content).toContain("provider-a / model-a | 12 | 3 | 15");
    expect(content).not.toContain("Vault-global intake and grooming aggregates were omitted");
  });

  it("attributes root-prefix grooming runs to a custom root shelf id", () => {
    const root: Shelf = {
      id: "overlay-main",
      label: "Overlay main",
      prefix: "",
      writable: true,
    };
    const router: VaultRouter = { shelves: () => [root], writeTarget: () => root };
    const { store } = boot(router);

    const run = store.groomingStoreForShelf(root).createCurationRun({
      trigger: "schedule",
      visibility: "common",
      project_key: null,
      input_hash: "custom-root",
    });

    expect(run).toMatchObject({ shelf_id: "overlay-main", shelf_label: "Overlay main" });
    expect(store.listCurationRuns({ shelfId: root.id }).map((row) => row.id)).toEqual([run.id]);
    expect(store.listCurationRuns({ shelfId: "main" })).toEqual([]);
  });

  it("projects cross-shelf commits before sending each shelf's facts to the narrator", async () => {
    const shelves: readonly Shelf[] = [
      { id: "team-a", label: "Team A", prefix: "teams/a/", writable: true },
      { id: "team-b", label: "Team B", prefix: "teams/b/", writable: true },
    ];
    const router: VaultRouter = { shelves: () => shelves, writeTarget: () => shelves[0]! };
    const { store } = boot(router);
    const provider = addProvider(store, {
      name: "Narrator",
      endpoint: "https://narrator.example/v1",
      token: "dummy-narrator-token",
    });
    writeConsumerConfig(store, "chronicle", { providerId: provider.id, model: "story-model" });
    vi.spyOn(store, "vaultActivity").mockImplementation(({ before }) =>
      before
        ? []
        : [
            {
              hash: "cross-shelf",
              date: "2026-07-29T10:00:00.000Z",
              author: "Jim",
              subject: "vault: move Team B secret into Team A",
              files: ["teams/a/memories/a.md", "teams/b/memories/b.md"],
              renames: [{ from: "teams/a/memories/old.md", to: "teams/b/memories/old.md" }],
            },
          ],
    );
    const prompts: string[] = [];
    const llm: LlmClient = {
      complete: vi.fn(async (input) => {
        prompts.push(input.messages[1]?.content ?? "");
        return {
          content: JSON.stringify({
            headline: "A shelf-safe week.",
            narrative_md: "Only this shelf's evidence was used.",
            blog_seeds: [],
          }),
          model: "story-model",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        };
      }),
    };

    await runChronicleTick({
      store,
      now: new Date(2026, 6, 29, 12, 0),
      trigger: "manual",
      allowDisabled: true,
      buildClient: () => llm,
    });

    expect(prompts).toHaveLength(2);
    const teamA = prompts.find((prompt) => prompt.includes("teams/a/memories/a.md"));
    const teamB = prompts.find((prompt) => prompt.includes("teams/b/memories/b.md"));
    expect(teamA).toBeDefined();
    expect(teamB).toBeDefined();
    expect(teamA).not.toContain("teams/b/");
    expect(teamB).not.toContain("teams/a/");
    expect(prompts.join("\n")).not.toContain("Team B secret");
  });

  it("records a collection failure as a failed run with no Chronicle write", async () => {
    const { store } = boot();
    vi.spyOn(store, "vaultActivity").mockImplementation(() => {
      throw new Error("private collection detail");
    });

    const result = await runChronicleTick({
      store,
      now: new Date(2026, 6, 29, 12, 0),
      trigger: "manual",
      allowDisabled: true,
    });

    expect(result).toMatchObject({ ran: true, attempted: 1, completed: 0, failed: 1 });
    expect(store.listChronicleRuns()[0]).toMatchObject({
      status: "failed",
      error: "collection_failed",
      path: null,
    });
    expect(() => store.vaultFiles.readFile("references/chronicle/2026-W31.md")).toThrow();
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

  it("overwrites a manual partial at the same weekly path with the completed scheduled entry", async () => {
    const { store } = boot();
    const manual = await runChronicleTick({
      store,
      now: new Date(2026, 6, 29, 12, 0),
      trigger: "manual",
      allowDisabled: true,
    });
    expect(manual).toMatchObject({ ran: true, period: { isoWeek: "2026-W31", partial: true } });
    const path = "references/chronicle/2026-W31.md";
    expect(store.vaultFiles.readFile(path).raw).toContain("partial — through 2026-07-29");

    writeChronicleConfig(store, { enabled: true, dayOfWeek: "monday", scheduleTime: "08:00" });
    const scheduled = await runScheduledChronicle({ store, now: new Date(2026, 7, 3, 8, 0) });

    expect(scheduled).toMatchObject({
      ran: true,
      period: { isoWeek: "2026-W31", partial: false },
      failed: 0,
    });
    expect(store.vaultFiles.readFile(path).raw).not.toContain("partial —");
    expect(store.listChronicleRuns().map((run) => run.path)).toEqual([path, path]);
  });

  it("writes the missed fire's week when catch-up crosses an ISO-week boundary", async () => {
    const { store } = boot();
    writeChronicleConfig(store, {
      enabled: true,
      dayOfWeek: "friday",
      scheduleTime: "17:30",
    });
    store.setSetting("chronicle.last_run_at", new Date(2026, 6, 31, 17, 30).toISOString());

    const result = await runScheduledChronicle({
      store,
      now: new Date(2026, 7, 10, 9, 0),
    });

    expect(result).toMatchObject({
      ran: true,
      period: { isoWeek: "2026-W31", partial: false },
      failed: 0,
    });
    expect(store.vaultFiles.readFile("references/chronicle/2026-W31.md").raw).toContain(
      "# Chronicle: 2026-W31",
    );
    expect(() => store.vaultFiles.readFile("references/chronicle/2026-W32.md")).toThrow();
  });

  it("isolates a shelf write failure and does not advance last_run_at", async () => {
    const shelves: readonly Shelf[] = [
      { id: "team-a", prefix: "teams/a/", writable: true },
      { id: "team-b", prefix: "teams/b/", writable: true },
    ];
    const router: VaultRouter = { shelves: () => shelves, writeTarget: () => shelves[0]! };
    const { store } = boot(router);
    writeChronicleConfig(store, { enabled: true, dayOfWeek: "monday", scheduleTime: "08:00" });
    const provider = addProvider(store, {
      name: "Narrator",
      endpoint: "https://narrator.example/v1",
      token: "dummy-narrator-token",
    });
    writeConsumerConfig(store, "chronicle", { providerId: provider.id, model: "story-model" });
    const llm: LlmClient = {
      complete: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          headline: "The week in evidence.",
          narrative_md: "A shelf-scoped account.",
          blog_seeds: [],
        }),
        model: "story-model",
        usage: { promptTokens: 40, completionTokens: 10, totalTokens: 50 },
      }),
    };
    const realWrite = store.systemWriteChronicle.bind(store);
    vi.spyOn(store, "systemWriteChronicle").mockImplementation((shelf, input) => {
      if (shelf.id === "team-a") throw new Error("private filesystem detail");
      return realWrite(shelf, input);
    });

    const result = await runScheduledChronicle({
      store,
      now: new Date(2026, 7, 3, 8, 0),
      runPass: (scheduledStore, now) =>
        runChronicleTick({ store: scheduledStore, now, buildClient: () => llm }),
    });

    expect(result).toMatchObject({ ran: true, attempted: 2, completed: 1, failed: 1 });
    expect(store.getSetting("chronicle.last_run_at")).toBeNull();
    expect(
      store
        .listChronicleRuns()
        .map((run) => [
          run.shelf_id,
          run.status,
          run.error,
          run.narrative,
          run.usage_input_tokens,
          run.usage_output_tokens,
        ]),
    ).toEqual([
      ["team-b", "completed", null, "generated", 40, 10],
      ["team-a", "failed", "write_failed", "generated", 40, 10],
    ]);
    expect(
      fs.existsSync(path.join(store.dataDir, "vault", "teams/b/references/chronicle/2026-W31.md")),
    ).toBe(true);
  });
});
