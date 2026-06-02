import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type ConversationStateStore,
  createConversationStateStore,
} from "./conversation-state-store.js";
import { createVault } from "./corpus/index.js";
import { searchReferences as searchVaultReferences } from "./corpus-index.js";
import { type CurationStore, createCurationStore } from "./curation-store.js";
import { createSyncGitOps } from "./git/index.js";
import { type HandoffStore, createHandoffStore } from "./handoff-store.js";
import { type ReferenceHit, createHashEmbedder } from "./index/index.js";
import { readJsonl } from "./jsonl.js";
import { createMarkdownHandoffStore, createMarkdownMemoryStore } from "./markdown/index.js";
import { type MemoryStore, createMemoryStore } from "./memory-store.js";
import { ensureSchema, rebuildMemoryIndex } from "./projection.js";
import { type SettingsStore, createSettingsStore } from "./settings-store.js";
import { createJsonConversationStateStore, createJsonSettingsStore } from "./sidecar/index.js";
import { type SkillStore, createSkillStore } from "./skills/index.js";

const DEFAULT_DATA_DIR = path.join(process.cwd(), "data");

/**
 * Resolve the data directory the store (and its sibling credential files) live in:
 * an explicit option wins, then `LIBRARIAN_DATA_DIR`, then `<cwd>/data`. Exported
 * so the boot path can place `secret.key`/`admin.token` in the exact same dir the
 * store will use, before the store (which needs the key) is constructed.
 */
export function resolveDataDir(dataDir?: string): string {
  return dataDir || process.env.LIBRARIAN_DATA_DIR || DEFAULT_DATA_DIR;
}

export interface LibrarianStoreOptions {
  dataDir?: string;
  /**
   * Master key for the admin secret-store (memory-curator §7.1). Resolved by
   * the caller from `LIBRARIAN_SECRET_KEY` via `resolveSecretKey`. When absent,
   * secret settings throw on access; plain settings still work.
   */
  secretKey?: Buffer | null;
  /**
   * Storage backend (plan 036 cutover). `sqlite` (default) is the legacy
   * event-ledger + SQLite projection. `markdown` routes memory/handoff to the
   * git vault and conv-state/settings to sidecar JSON files; a residual SQLite
   * db backs only the (dormant) curator until the Phase-4 consolidator lands.
   * Falls back to `LIBRARIAN_BACKEND`.
   */
  backend?: "sqlite" | "markdown";
}

export interface LibrarianStore extends MemoryStore, CurationStore, SettingsStore {
  convState: ConversationStateStore;
  handoffs: HandoffStore;
  /** Skills read surface (vault-based, backend-independent): manifest + get + find. */
  skills: SkillStore;
  /** Tier-0 reference lookup over the vault's references/ (backend-independent). */
  searchReferences(query: string, limit?: number): Promise<ReferenceHit[]>;
  dataDir: string;
  close(): void;
  /** Backend-neutral maintenance verb: rebuild the disposable memory index. */
  reindex(): void;
}

/**
 * The concrete store, which also exposes the raw SQLite handle and event-ledger
 * paths — the storage seam (F0). Only the storage layer itself and the
 * not-yet-migrated classifier (Phase 4) and backup (Phase 7) machinery may use
 * these; all other code receives the narrow `LibrarianStore`. Reach for this
 * type only when you genuinely must bypass the seam — it collapses back into
 * `LibrarianStore` once those subsystems are retired.
 */
export interface InternalLibrarianStore extends LibrarianStore {
  eventsPath: string;
  dbPath: string;
  snapshotPath: string;
  db: DatabaseSync;
  readEvents(): Record<string, unknown>[];
  rebuildIndex(): void;
}

export function createLibrarianStore(options: LibrarianStoreOptions = {}): InternalLibrarianStore {
  const dataDir = resolveDataDir(options.dataDir);
  const eventsPath = path.join(dataDir, "events.jsonl");
  const dbPath = path.join(dataDir, "librarian.sqlite");
  const snapshotPath = path.join(dataDir, "memories.md");

  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(eventsPath)) fs.writeFileSync(eventsPath, "", "utf8");

  // sessions-rethink PR 7 — rename any leftover session ledger files to
  // `.predeprecation.bak` so operators can see they've been retired. The
  // new build never reads or writes them; deletion is left to the
  // operator's choice.
  for (const stem of ["session_events.jsonl", "sessions.legacy.jsonl", "sessions.jsonl"]) {
    const src = path.join(dataDir, stem);
    if (!fs.existsSync(src)) continue;
    const bak = `${src}.predeprecation.bak`;
    try {
      fs.renameSync(src, bak);
    } catch {
      /* ignore — best-effort cleanup */
    }
  }

  const db = new DatabaseSync(dbPath);
  ensureSchema(db, { eventsPath, snapshotPath });

  const backend =
    options.backend ??
    (process.env.LIBRARIAN_BACKEND === "markdown" ? "markdown" : undefined) ??
    "sqlite";

  if (backend === "markdown") {
    // Store cutover (plan 036 Phase 2): memory + handoff live in the git
    // vault; conv-state + settings/secrets in sidecar JSON files outside it.
    // The SQLite `db` created above is residual — it backs only the (dormant)
    // curator/curation until the Phase-4 consolidator reworks the read-side
    // and SQLite is removed for good. The event ledger is retired, so
    // appendEvent/listEvents (markdown stubs) throw and readEvents is empty.
    const vault = createVault({ dataDir });
    const git = createSyncGitOps({ cwd: vault.root });
    git.init();
    const commit = (message: string): void => {
      git.commitAll(message);
    };
    const markdownMemory = createMarkdownMemoryStore({ vault, commit });
    const markdownHandoffs = createMarkdownHandoffStore({ vault, commit });
    const jsonConvState = createJsonConversationStateStore({
      filePath: path.join(dataDir, "conv-state.json"),
    });
    const jsonSettings = createJsonSettingsStore({
      filePath: path.join(dataDir, "settings.json"),
      secretKey: options.secretKey ?? null,
    });
    const residualCuration = createCurationStore({ db });
    return {
      ...markdownMemory,
      ...residualCuration,
      ...jsonSettings,
      convState: jsonConvState,
      handoffs: markdownHandoffs,
      skills: createSkillStore(vault),
      searchReferences: (query, limit) =>
        searchVaultReferences(vault, createHashEmbedder(), query, limit),
      dataDir,
      eventsPath,
      dbPath,
      snapshotPath,
      db,
      close: () => db.close(),
      readEvents: () => [],
      rebuildIndex: () => {},
      reindex: () => {},
    };
  }

  function rebuildIndex(): void {
    rebuildMemoryIndex({ db, eventsPath, snapshotPath });
  }

  const memoryStore = createMemoryStore({
    db,
    eventsPath,
    rebuildMemoryIndex: rebuildIndex,
  });
  const curationStore = createCurationStore({ db });
  const settingsStore = createSettingsStore({ db, secretKey: options.secretKey ?? null });
  const convState = createConversationStateStore({ db });
  const handoffs = createHandoffStore({ db });

  return {
    ...memoryStore,
    ...curationStore,
    ...settingsStore,
    convState,
    handoffs,
    // create:false — a SQLite install must not materialize a vault dir just to
    // expose these read-only vault surfaces; they appear only once files exist.
    skills: createSkillStore(createVault({ dataDir, create: false })),
    searchReferences: (query, limit) =>
      searchVaultReferences(
        createVault({ dataDir, create: false }),
        createHashEmbedder(),
        query,
        limit,
      ),
    dataDir,
    eventsPath,
    dbPath,
    snapshotPath,
    db,
    close: () => db.close(),
    readEvents: () => readJsonl(eventsPath),
    rebuildIndex,
    reindex: rebuildIndex,
  };
}
