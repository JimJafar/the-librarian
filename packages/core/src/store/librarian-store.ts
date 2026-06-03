import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type ConsolidationThresholds,
  type SweepSummary,
  runConsolidatorSweep,
} from "../consolidator/index.js";
import type { LlmClient } from "../curator-llm-client.js";
import { createVaultCuratorMemorySource } from "../curator-source-vault.js";
import { MemoryStatus } from "../schemas/common.js";
import {
  type ConversationStateStore,
  createConversationStateStore,
} from "./conversation-state-store.js";
import {
  type InboxItemRef,
  type InboxSubmissionHints,
  createVault,
  writeInbox,
} from "./corpus/index.js";
import {
  buildCorpusIndex,
  recallMemories,
  searchReferences as searchVaultReferences,
} from "./corpus-index.js";
import { type CurationStore, createCurationStore } from "./curation-store.js";
import { createSyncGitOps } from "./git/index.js";
import { type HandoffStore, createHandoffStore } from "./handoff-store.js";
import {
  type NamespacedIndex,
  type ReferenceHit,
  createCachingEmbedder,
  resolveEmbedder,
} from "./index/index.js";
import { readJsonl } from "./jsonl.js";
import { createMarkdownHandoffStore, createMarkdownMemoryStore } from "./markdown/index.js";
import { type Memory, type MemoryStore, createMemoryStore } from "./memory-store.js";
import { ensureSchema, rebuildMemoryIndex } from "./projection.js";
import { type SettingsStore, createSettingsStore } from "./settings-store.js";
import {
  createJsonConversationStateStore,
  createJsonCurationStore,
  createJsonSettingsStore,
} from "./sidecar/index.js";
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

export type StorageBackend = "sqlite" | "markdown";

/**
 * The backend a shipped server/CLI boot should use: **markdown by default** (the
 * plan-036 cutover), with `LIBRARIAN_BACKEND=sqlite` as the explicit opt-out.
 * The boot entrypoints (http/stdio/CLI) call this and pass it explicitly.
 *
 * NB: createLibrarianStore's own library default stays `sqlite` (for back-compat
 * + the SQLite-specific tests, which are retired with SQLite in Phase 4). This
 * helper is the product-level cutover switch — it does not change that default.
 */
export function resolveBackend(): StorageBackend {
  const env = process.env.LIBRARIAN_BACKEND;
  if (env === undefined || env === "") return "markdown";
  if (env === "sqlite" || env === "markdown") return env;
  throw new Error(`LIBRARIAN_BACKEND must be "sqlite" or "markdown" (got "${env}")`);
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
  /** The storage backend this store actually runs (so callers don't re-derive it from env). */
  backend: StorageBackend;
  convState: ConversationStateStore;
  handoffs: HandoffStore;
  /** Skills read surface (vault-based, backend-independent): manifest + get + find. */
  skills: SkillStore;
  /** Tier-0 reference lookup over the vault's references/ (backend-independent). */
  searchReferences(query: string, limit?: number): Promise<ReferenceHit[]>;
  /**
   * Memory recall. On markdown this is index-backed (hybrid keyword+vector,
   * backlink-aware); on sqlite it delegates to the keyword searchMemories. A
   * filter-only (no-query) call falls back to searchMemories on both.
   */
  recall(input?: Record<string, unknown>): Promise<Memory[]>;
  /**
   * Submit raw text to the consolidator inbox (markdown backend only — the inbox
   * lives in the vault). Fire-and-forget: stored + committed instantly; the
   * consolidator files it asynchronously, carrying `hints` (the submitter's
   * agent_id/project_key/tags) onto the resulting memory. Throws on sqlite.
   */
  submitToInbox(text: string, hints?: InboxSubmissionHints): InboxItemRef;
  /**
   * Run the consolidator over the inbox once — reap stale claims, then FIFO
   * through navigate→judge→apply (markdown backend only). The LLM client is
   * injected by the caller (built from admin config). Returns a sweep summary.
   */
  consolidateInbox(deps: ConsolidateInboxOptions): Promise<SweepSummary>;
  dataDir: string;
  close(): void;
  /** Backend-neutral maintenance verb: rebuild the disposable memory index. */
  reindex(): void;
}

/** Options for `LibrarianStore.consolidateInbox`. */
export interface ConsolidateInboxOptions {
  llmClient: LlmClient;
  thresholds?: ConsolidationThresholds;
  /** Stale-claim TTL for the reaper (defaults to the sweep's 60 min). */
  lockTtlMs?: number;
  /** Per-item error sink — called for each item whose processing threw (LLM/transport). */
  onError?: (error: unknown) => void;
}

/** Actor id that owns consolidator writes (common-slice, system-owned). */
const CONSOLIDATOR_ACTOR_ID = "system-consolidator";

/**
 * The error message the inbox verbs throw/reject with on a non-markdown backend
 * (the inbox lives in the vault). Exported as the single source of truth so
 * callers can detect it exactly rather than substring-matching a drifting string.
 */
export const CONSOLIDATOR_REQUIRES_MARKDOWN = "the consolidator requires the markdown backend";

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
    // Index embedder for recall + references — hash under tests, the real model
    // (EmbeddingGemma) in production (see resolveEmbedder). Wrapped in a content
    // cache that OUTLIVES index rebuilds: the index is invalidated on every
    // memory write and rebuilt from scratch, re-embedding all active docs, so
    // without this a bulk groom (e.g. seeding N memories) re-embeds the growing
    // corpus O(N^2) times. The cache makes each distinct doc embed once.
    const embedder = createCachingEmbedder(resolveEmbedder({ dataDir }));
    // Disposable recall index, built lazily + cached, invalidated on every
    // memory write (onWrite) so recall doesn't rebuild + re-embed the corpus
    // per call. References change via the filesystem, not memory writes, but
    // recall only reads the corpus namespace, so memory-write invalidation
    // suffices for recall (search_references builds its own index).
    let cachedIndex: Promise<NamespacedIndex> | null = null;
    const markdownMemory = createMarkdownMemoryStore({
      vault,
      commit,
      onWrite: () => {
        cachedIndex = null;
      },
    });
    const markdownHandoffs = createMarkdownHandoffStore({ vault, commit });
    const corpusIndex = (): Promise<NamespacedIndex> =>
      (cachedIndex ??= buildCorpusIndex(vault, { embedder }).catch((error: unknown) => {
        cachedIndex = null; // a failed/transient build (e.g. real embedder load) must not poison recall
        throw error;
      }));
    const jsonConvState = createJsonConversationStateStore({
      filePath: path.join(dataDir, "conv-state.json"),
    });
    const jsonSettings = createJsonSettingsStore({
      filePath: path.join(dataDir, "settings.json"),
      secretKey: options.secretKey ?? null,
    });
    // Curator read-side over the vault (Phase 4): memory evidence + slice
    // enumeration come from the markdown memory store; run/operation bookkeeping
    // lives in a sidecar JSON file (curation-runs.json), NOT the residual SQLite
    // `db` (SQLite-removal c.1c-i). The `db` opened above is now used by the
    // markdown branch only to satisfy the InternalLibrarianStore contract +
    // close(); a follow-on makes `db` optional and stops opening it here (c.1c-ii).
    const markdownCuration = createJsonCurationStore({
      filePath: path.join(dataDir, "curation-runs.json"),
      memorySource: createVaultCuratorMemorySource(markdownMemory),
    });
    // Index-backed recall, extracted so the consolidator's navigate step can
    // reuse the exact same recall the `recall` verb uses.
    const storeRecall = async (input: Record<string, unknown> = {}): Promise<Memory[]> => {
      const query = typeof input.query === "string" ? input.query : "";
      // filter-only (no query) stays on the keyword path
      if (!query.trim()) return markdownMemory.searchMemories(input);
      return recallMemories(
        { index: await corpusIndex(), getMemory: (id) => markdownMemory.getMemory(id) },
        query,
        {
          projectKey: typeof input.project_key === "string" ? input.project_key : undefined,
          tags: Array.isArray(input.tags) ? (input.tags as string[]) : undefined,
          limit: typeof input.limit === "number" ? input.limit : undefined,
        },
      );
    };
    return {
      ...markdownMemory,
      ...markdownCuration,
      ...jsonSettings,
      backend: "markdown",
      convState: jsonConvState,
      handoffs: markdownHandoffs,
      skills: createSkillStore(vault),
      searchReferences: (query, limit) => searchVaultReferences(vault, embedder, query, limit),
      recall: storeRecall,
      submitToInbox: (text: string, hints?: InboxSubmissionHints) => {
        const ref = writeInbox(vault, text, hints ? { hints } : {});
        commit(`inbox: submit ${ref.id}`); // durable + committed instantly
        return ref;
      },
      consolidateInbox: async (deps): Promise<SweepSummary> => {
        // PERF: each applied item invalidates the recall index (onWrite) and the
        // next item's navigate rebuilds + re-embeds the corpus; listActive also
        // re-reads the vault per item. Correct (later items see earlier filings,
        // S1/G6) but ~O(items) rebuilds — batch/defer index invalidation across a
        // sweep when the real embedder makes this a hot spot. Fine while sweeps
        // are serial + off the hot path.
        const summary = await runConsolidatorSweep({
          vault,
          recall: (q, n) => storeRecall({ query: q, limit: n }),
          listActive: () => markdownMemory.listAll({ status: MemoryStatus.Active }),
          store: markdownMemory,
          actorId: CONSOLIDATOR_ACTOR_ID,
          llmClient: deps.llmClient,
          ...(deps.thresholds ? { thresholds: deps.thresholds } : {}),
          ...(deps.lockTtlMs !== undefined ? { lockTtlMs: deps.lockTtlMs } : {}),
          ...(deps.onError ? { onError: deps.onError } : {}),
        });
        // The apply path commits per memory write; commit once more to capture
        // the inbox claim/complete moves a no-op or judge-error sweep leaves
        // behind (commitAll is a no-op when the tree is already clean).
        commit("inbox: consolidate sweep");
        return summary;
      },
      dataDir,
      eventsPath,
      dbPath,
      snapshotPath,
      db,
      close: () => db.close(),
      readEvents: () => [],
      rebuildIndex: () => {},
      // drop the cached recall index → next recall rebuilds from the vault
      // (also picks up out-of-band vault edits, e.g. a hand-added reference).
      reindex: () => {
        cachedIndex = null;
      },
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
  // one shared (lazy) embedder so a real model isn't reloaded per call
  const embedder = resolveEmbedder({ dataDir });

  return {
    ...memoryStore,
    ...curationStore,
    ...settingsStore,
    backend: "sqlite",
    convState,
    handoffs,
    // create:false — a SQLite install must not materialize a vault dir just to
    // expose these read-only vault surfaces; they appear only once files exist.
    skills: createSkillStore(createVault({ dataDir, create: false })),
    searchReferences: (query, limit) =>
      searchVaultReferences(createVault({ dataDir, create: false }), embedder, query, limit),
    // sqlite recall is the keyword searchMemories (no markdown vault to index)
    recall: (input = {}) => Promise.resolve(memoryStore.searchMemories(input)),
    // The consolidator inbox lives in the markdown vault — not available on sqlite.
    submitToInbox: () => {
      throw new Error(CONSOLIDATOR_REQUIRES_MARKDOWN);
    },
    consolidateInbox: () => Promise.reject(new Error(CONSOLIDATOR_REQUIRES_MARKDOWN)),
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
