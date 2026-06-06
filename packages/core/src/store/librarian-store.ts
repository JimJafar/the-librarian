import fs from "node:fs";
import path from "node:path";
import {
  type ConsolidationThresholds,
  type SweepSummary,
  runConsolidatorSweep,
} from "../consolidator/index.js";
import type { CuratorConsumer } from "../curator-consumers.js";
import type { LlmClient } from "../curator-llm-client.js";
import { createVaultCuratorMemorySource } from "../curator-source-vault.js";
import { MemoryStatus } from "../schemas/common.js";
import type { ConsolidationStore } from "./consolidation-store.js";
import type { ConversationStateStore } from "./conversation-state-store.js";
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
import type { CurationStore } from "./curation-store.js";
import { type GitPushAuth, createSyncGitOps } from "./git/index.js";
import type { HandoffStore } from "./handoff-store.js";
import {
  type NamespacedIndex,
  type ReferenceHit,
  createCachingEmbedder,
  resolveEmbedder,
} from "./index/index.js";
import { createMarkdownHandoffStore, createMarkdownMemoryStore } from "./markdown/index.js";
import type { Memory, MemoryStore } from "./memory-store.js";
import type { SettingsStore } from "./settings-store.js";
import {
  createJsonConsolidationStore,
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

export interface LibrarianStoreOptions {
  dataDir?: string;
  /**
   * Master key for the admin secret-store (memory-curator §7.1). Resolved by
   * the caller from `LIBRARIAN_SECRET_KEY` via `resolveSecretKey`. When absent,
   * secret settings throw on access; plain settings still work.
   */
  secretKey?: Buffer | null;
}

export interface LibrarianStore
  extends MemoryStore, CurationStore, ConsolidationStore, SettingsStore {
  /** The storage backend (always "markdown" now SQLite is removed). */
  backend: "markdown";
  convState: ConversationStateStore;
  handoffs: HandoffStore;
  /** Skills read surface (vault-based, backend-independent): manifest + get + find. */
  skills: SkillStore;
  /** Tier-0 reference lookup over the vault's references/ (backend-independent). */
  searchReferences(query: string, limit?: number): Promise<ReferenceHit[]>;
  /**
   * Memory recall — index-backed (hybrid keyword+vector, backlink-aware). A
   * filter-only (no-query) call falls back to the keyword searchMemories.
   */
  recall(input?: Record<string, unknown>): Promise<Memory[]>;
  /**
   * Submit raw text to the consolidator inbox (the inbox lives in the vault).
   * Fire-and-forget: stored + committed instantly; the consolidator files it
   * asynchronously, carrying `hints` (the submitter's agent_id/project_key/tags)
   * onto the resulting memory.
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
  /**
   * Back up the git vault by pushing it to a remote (the vault IS the backed-up
   * artifact). Commits any pending changes, then pushes HEAD to the remote branch
   * via the GIT_ASKPASS path (the token never leaks). Returns the pushed commit
   * hash, or null if the vault has no commits yet.
   */
  pushVaultBackup(auth: GitPushAuth): string | null;
  /**
   * Read a curator job's prompt addendum from its committed vault file
   * (`.curator/<job>-addendum.md`, spec 044 D-1). Fail-soft: a missing file
   * returns `{ content: "", version: null }` (never throws). `version` is the
   * git commit hash that last touched the file — load-bearing for 2C's
   * self-improvement loop (proposal tagging + git rollback); null until the file
   * has history.
   */
  readAddendum(job: CuratorConsumer): AddendumRecord;
  /**
   * Write a curator job's prompt addendum to its committed vault file AND commit
   * it (spec 044 D-1), so it is versioned + appears in `git log`. Returns the
   * post-write record (content + the new version hash).
   */
  writeAddendum(job: CuratorConsumer, content: string): AddendumRecord;
}

/** A curator job's addendum content + its git version (spec 044 D-1). */
export interface AddendumRecord {
  /** The addendum text (empty string when the file is absent — fail-soft). */
  content: string;
  /** The commit hash that last touched the file, or null when it has no history. */
  version: string | null;
}

/**
 * Vault-relative path of a job's committed addendum file (spec 044 D-1):
 * `.curator/intake-addendum.md` / `.curator/grooming-addendum.md`.
 */
export function addendumPath(job: CuratorConsumer): string {
  return `.curator/${job}-addendum.md`;
}

/** Options for `LibrarianStore.consolidateInbox`. */
export interface ConsolidateInboxOptions {
  llmClient: LlmClient;
  thresholds?: ConsolidationThresholds;
  /** Stale-claim TTL for the reaper (defaults to the sweep's 60 min). */
  lockTtlMs?: number;
  /** Per-item error sink — called for each item whose processing threw (LLM/transport). */
  onError?: (error: unknown) => void;
  /** What opened this sweep (boot | tick | watcher | manual); recorded on the decision-log run. */
  trigger?: string;
  /**
   * Operator steering for the judge prompt (spec 044 D-2), read ONCE per sweep by
   * the caller (`readJobAddendum(store,"intake").content`) and threaded into every
   * item's judge call. Empty/absent → today's behaviour (no OPERATOR GUIDANCE).
   */
  promptAddendum?: string;
}

/** Actor id that owns consolidator writes (common-slice, system-owned). */
const CONSOLIDATOR_ACTOR_ID = "system-consolidator";

/**
 * Historically the concrete store exposed the raw SQLite handle + event-ledger
 * paths (the storage seam). With SQLite removed there is nothing extra to expose,
 * so it has collapsed into `LibrarianStore` — kept as an alias for callers that
 * still name the internal type.
 */
export type InternalLibrarianStore = LibrarianStore;

export function createLibrarianStore(options: LibrarianStoreOptions = {}): LibrarianStore {
  const dataDir = resolveDataDir(options.dataDir);

  fs.mkdirSync(dataDir, { recursive: true });

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

  // Memory + handoff live in the git vault; conv-state + settings/secrets in
  // sidecar JSON files outside it. The event ledger is retired, so the markdown
  // stubs for appendEvent/listEvents throw.
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
  // lives in a sidecar JSON file (curation-runs.json).
  const markdownCuration = createJsonCurationStore({
    filePath: path.join(dataDir, "curation-runs.json"),
    memorySource: createVaultCuratorMemorySource(markdownMemory),
  });
  // Intake decision log (spec 043 C1) — the consolidator's full-outcome sidecar,
  // paralleling curation-runs.json. Purely observational + fail-soft, so it never
  // affects filing; the sweep wires it below.
  const markdownConsolidation = createJsonConsolidationStore({
    filePath: path.join(dataDir, "consolidation-runs.json"),
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
    ...markdownConsolidation,
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
        // Observational decision log — fail-soft inside the sweep, never affects filing.
        consolidationLog: markdownConsolidation,
        consolidationTrigger: deps.trigger ?? "manual",
        ...(deps.thresholds ? { thresholds: deps.thresholds } : {}),
        ...(deps.lockTtlMs !== undefined ? { lockTtlMs: deps.lockTtlMs } : {}),
        ...(deps.onError ? { onError: deps.onError } : {}),
        ...(deps.promptAddendum ? { promptAddendum: deps.promptAddendum } : {}),
      });
      // The apply path commits per memory write; commit once more to capture
      // the inbox claim/complete moves a no-op or judge-error sweep leaves
      // behind (commitAll is a no-op when the tree is already clean).
      commit("inbox: consolidate sweep");
      return summary;
    },
    dataDir,
    close: () => {},
    // drop the cached recall index → next recall rebuilds from the vault
    // (also picks up out-of-band vault edits, e.g. a hand-added reference).
    reindex: () => {
      cachedIndex = null;
    },
    pushVaultBackup: (auth) => {
      // Every memory write already commits, but capture any out-of-band edits
      // (e.g. a hand-added reference) before the push so nothing is left behind.
      commit("backup: snapshot");
      const head = git.head();
      // A commitless vault (fresh install, no memories yet) has nothing to push —
      // pushing HEAD would fail ("src refspec HEAD does not match any").
      if (!head) return null;
      git.push(auth);
      return head;
    },
    // Curator addenda live as committed vault files (spec 044 D-1): same
    // write+commit primitive as memory/handoff, read back as raw text (no
    // frontmatter), versioned by the file's last-touching commit hash.
    readAddendum: (job) => {
      const rel = addendumPath(job);
      const content = vault.tryReadText(rel) ?? "";
      // The version is meaningful only when the file actually exists on disk;
      // lastCommitFor would otherwise return null anyway, but skip the git call.
      const version = vault.exists(rel) ? git.lastCommitFor(rel) : null;
      return { content, version };
    },
    writeAddendum: (job, content) => {
      const rel = addendumPath(job);
      vault.writeText(rel, content);
      commit(`curator: addendum ${job}`);
      return { content, version: git.lastCommitFor(rel) };
    },
  };
}
