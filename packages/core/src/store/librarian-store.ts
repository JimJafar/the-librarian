import fs from "node:fs";
import path from "node:path";
import type { CuratorConsumer } from "../curator-consumers.js";
import type { LlmClient } from "../grooming-llm-client.js";
import { createVaultGroomingMemorySource } from "../grooming-source-vault.js";
import { type SweepSummary, runIntakeSweep } from "../intake/index.js";
import { PRIMER_PATH, type PrimerStore } from "../primer.js";
import { MemoryStatus } from "../schemas/common.js";
import { type VaultRouter, defaultVaultRouter } from "../vault-router.js";
import {
  type InboxItemRef,
  type InboxSubmissionHints,
  createVault,
  writeInbox,
} from "./corpus/index.js";
import {
  type CorpusIndex,
  type ReferenceHit,
  buildCorpusIndex,
  recallMemories,
  searchReferences as searchVaultReferences,
} from "./corpus-index.js";
import type { CurationStore } from "./curation-store.js";
import {
  type CommitDiff,
  type GitPushAuth,
  type VaultCommit,
  createGitHistory,
  createSyncGitOps,
} from "./git/index.js";
import type { HandoffStore } from "./handoff-store.js";
import { createCachingEmbedder, createEmbeddingCache, resolveEmbedder } from "./index/index.js";
import type { IntakeStore } from "./intake-store.js";
import { createMarkdownHandoffStore, createMarkdownMemoryStore } from "./markdown/index.js";
import type { Memory, MemoryStore } from "./memory-store.js";
import type { SettingsStore } from "./settings-store.js";
import {
  createJsonIntakeStore,
  createJsonCurationStore,
  createJsonSettingsStore,
  resolveIntakeRunsPath,
} from "./sidecar/index.js";
import { type VaultFileStore, createVaultFileStore } from "./vault-files.js";
import {
  type VaultCommitSource,
  type VaultRestoreOptions,
  type VaultRestoreResult,
  classifyVaultCommit,
  restoreVaultToCommit,
} from "./vault-restore.js";

const DEFAULT_DATA_DIR = path.join(process.cwd(), "data");

/**
 * Resolve the data directory the store (and its sibling credential files) live in:
 * an explicit option wins, then `LIBRARIAN_DATA_DIR`, then `<cwd>/data`. Exported
 * so the boot path can place `secret.key` in the exact same dir the store will
 * use, before the store (which needs the key) is constructed.
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
   * The vault-set router (spec 062 SC 2, ADR 0011 Decision 3): "which shelves does this
   * principal see, and where do writes land?". Defaults to {@link defaultVaultRouter} — the
   * inert OSS single-shelf-at-the-root behaviour. The 060 factory threads a plugin-supplied
   * router here (discharging spec 060 review residual 2).
   *
   * At spec 062 T1 the store STORES + exposes this ({@link LibrarianStore.vaultRouter}) but
   * reads it for NO routing decision yet — every path still hard-codes the vault root, so
   * behaviour is byte-identical to before. The shelf-scoped read/write paths (and the store's
   * runtime `validateShelfSet` application on each materialised set) land in later 062 tasks.
   */
  vaultRouter?: VaultRouter;
}

export interface LibrarianStore
  extends MemoryStore, CurationStore, IntakeStore, SettingsStore, PrimerStore {
  handoffs: HandoffStore;
  /**
   * The dashboard's Obsidian-lite vault explorer/editor surface (rethink
   * T18/T19): tree + raw read + backlinks, and validated, compare-and-swap
   * writes that commit per write and invalidate the recall index like every
   * other vault mutation.
   */
  vaultFiles: VaultFileStore;
  /**
   * The vault-set router this store was constructed with (spec 062 SC 2) — the
   * plugin-supplied {@link VaultRouter} or {@link defaultVaultRouter}. Exposed so the 060
   * factory's delivery test can prove the SAME reference threaded through the store options
   * also reaches the server handle's `internals`. At spec 062 T1 it is stored inert: NO store
   * path consults it, so behaviour is unchanged (the shelf-scoped paths are later 062 tasks).
   */
  vaultRouter: VaultRouter;
  /** Tier-0 reference lookup over the vault's references/ (backend-independent). */
  searchReferences(query: string, limit?: number): Promise<ReferenceHit[]>;
  /**
   * How many reference documents the vault holds — the denominator the
   * dashboard's reference tester uses to tell "no references filed" apart from
   * "references exist but none matched". Counts exactly what searchReferences
   * indexes (the markdown under references/).
   */
  countReferences(): number;
  /**
   * Memory recall — index-backed (hybrid keyword+vector, backlink-aware). A
   * filter-only (no-query) call falls back to the keyword searchMemories.
   */
  recall(input?: Record<string, unknown>): Promise<Memory[]>;
  /**
   * Submit raw text to the intake inbox (the inbox lives in the vault).
   * Fire-and-forget: stored + committed instantly; the intake files it
   * asynchronously, carrying `hints` (the submitter's agent_id/tags/applies_to)
   * onto the resulting memory.
   */
  submitToInbox(text: string, hints?: InboxSubmissionHints): InboxItemRef;
  /**
   * Run the intake over the inbox once — reap stale claims, then FIFO
   * through navigate→judge→apply (markdown backend only). The LLM client is
   * injected by the caller (built from admin config). Returns a sweep summary.
   */
  runIntakeSweep(deps: IntakeInboxOptions): Promise<SweepSummary>;
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
   * The vault-wide activity feed (rethink T21, spec §8 / D16): recent vault
   * commits newest-first, each with the files it touched and a provenance
   * `source` derived from the commit-subject conventions (see
   * classifyVaultCommit). `before` pages strictly-older commits. This surface
   * IS the audit trail — it replaces the retired event ledger.
   */
  vaultActivity(input?: { limit?: number; before?: string }): VaultActivityEntry[];
  /**
   * The per-file diffs introduced by a single vault commit (rethink T21
   * activity-feed accordion). Throws `GitHashError` on a malformed hash;
   * returns an empty `files` array for a commit unknown to the repo (the
   * caller surfaces this as a not-found teaching error at the tRPC boundary).
   */
  vaultCommitDiff(hash: string): CommitDiff;
  /**
   * The guarded whole-vault restore (rethink T21, spec §8 / D16): refuse
   * while a curation run is in flight or another restore holds the lock →
   * pause the curator (both ticks check it) → `pre-restore-<timestamp>` tag
   * on HEAD → revert the working tree to `hash`'s tree state as ONE new
   * commit → invalidate the index → resume the curator (try/finally — a
   * mid-sequence failure still resumes, and the error reports how far it
   * got). The typed-confirmation gate lives at the tRPC boundary.
   */
  restoreVaultTo(hash: string, options?: VaultRestoreOptions): Promise<VaultRestoreResult>;
  /**
   * Read a curator job's prompt addendum from its committed vault file
   * (`.curator/<job>-addendum.md`, spec 044 D-1). Fail-soft: a missing file
   * returns `{ content: "", version: null }` (never throws). `version` is the
   * git commit hash that last touched the file (the rollback anchor); null until
   * the file has history.
   */
  readAddendum(job: CuratorConsumer): AddendumRecord;
  /**
   * Write a curator job's prompt addendum to its committed vault file AND commit
   * it (spec 044 D-1), so it is versioned + appears in `git log`. Returns the
   * post-write record (content + the new version hash).
   */
  writeAddendum(job: CuratorConsumer, content: string): AddendumRecord;
  /**
   * Roll a curator job's addendum back to its PRIOR committed version (rethink D4:
   * git is the rollback): restore the file to the commit before its current one in
   * the file's own git history, then COMMIT the restoration so the roll-back is
   * itself a revertable commit. Edge cases:
   *   - only one committed version → restore to empty (the pre-existence state),
   *     committed (`restored: true`);
   *   - no committed version at all → safe no-op (`restored: false`, version null).
   * Surgical: touches ONLY this job's addendum file, never other vault state.
   */
  rollbackAddendum(job: CuratorConsumer): RollbackAddendumResult;
  /**
   * Read the intake examples document (`.curator/intake-examples.md`,
   * proposal-review rework F4 / D3) — the curator-distilled rejected-submission
   * examples that ride the intake prompt. Same fail-soft record shape as the
   * addendum: missing file → `{ content: "", version: null }`.
   */
  readIntakeExamples(): AddendumRecord;
  /**
   * Write the intake examples document AND commit it. The byte-cap policy
   * (`curator.intake.examples_max_bytes`) lives in curator-examples.ts's
   * setIntakeExamples — this is the raw committed-file primitive.
   */
  writeIntakeExamples(content: string): AddendumRecord;
  /**
   * Roll the examples document back to its prior committed version, committed
   * as a new revertable commit — the same surgical semantics as
   * rollbackAddendum, over the examples file only.
   */
  rollbackIntakeExamples(): RollbackAddendumResult;
}

/** One activity-feed entry: a vault commit + its subject-derived provenance. */
export interface VaultActivityEntry extends VaultCommit {
  source: VaultCommitSource;
}

/** A curator job's addendum content + its git version (spec 044 D-1). */
export interface AddendumRecord {
  /** The addendum text (empty string when the file is absent — fail-soft). */
  content: string;
  /** The commit hash that last touched the file, or null when it has no history. */
  version: string | null;
}

/** The outcome of a `rollbackAddendum`. */
export interface RollbackAddendumResult {
  /** True when a restoration commit was made (prior version OR empty); false on a no-op. */
  restored: boolean;
  /** The new HEAD commit hash for the file after the roll-back, or null on a no-op. */
  version: string | null;
}

/**
 * Vault-relative path of a job's committed addendum file (spec 044 D-1):
 * `.curator/intake-addendum.md` / `.curator/grooming-addendum.md`.
 */
export function addendumPath(job: CuratorConsumer): string {
  return `.curator/${job}-addendum.md`;
}

/**
 * Vault-relative path of the intake examples document (proposal-review rework
 * F4 / D3) — the addendum's sibling: `.curator/intake-examples.md`.
 */
export const INTAKE_EXAMPLES_PATH = ".curator/intake-examples.md";

/** Options for `LibrarianStore.runIntakeSweep`. */
export interface IntakeInboxOptions {
  llmClient: LlmClient;
  /** The single curator.apply.confidence_threshold knob (D13); default 0.8. */
  confidenceThreshold?: number;
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
  /**
   * The intake examples document (proposal-review rework F4 / D3), read ONCE
   * per sweep by the caller (`readIntakeExamples(store).content`) and threaded
   * into every item's judge call. Empty/absent → no examples block.
   */
  intakeExamples?: string;
}

/** Actor id that owns intake writes (common-slice, system-owned). */
const INTAKE_ACTOR_ID = "system-consolidator";

export function createLibrarianStore(options: LibrarianStoreOptions = {}): LibrarianStore {
  const dataDir = resolveDataDir(options.dataDir);
  // The vault-set router (spec 062 T1). Stored + exposed below, but read for NO decision
  // yet — every path still hard-codes the vault root, so behaviour is byte-identical. The
  // default is the inert single-shelf OSS router.
  const vaultRouter = options.vaultRouter ?? defaultVaultRouter;

  fs.mkdirSync(dataDir, { recursive: true });

  // Memory + handoff live in the git vault; settings/secrets in sidecar JSON
  // files outside it.
  const vault = createVault({ dataDir });
  // scratchDir = the data dir: the GIT_ASKPASS helper push() writes must be on an
  // exec-capable filesystem, and a read_only container's /tmp is noexec (would
  // break backup). The data dir is a writable, exec-capable volume outside the
  // vault working tree (`<dataDir>/vault`). See runGitWithToken.
  const git = createSyncGitOps({ cwd: vault.root, scratchDir: dataDir });
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
  // Persistent embedding cache (rethink T23): chunk/doc vectors keyed by
  // (file path, content hash, model id), in a sidecar OUTSIDE the vault — it
  // is derived state and must never be git-committed/pushed with the vault.
  // This is what makes a process restart cheap: the in-memory caching embedder
  // above dies with the process; this survives it, so a second boot re-embeds
  // nothing that hasn't changed (references AND memories). Skipped (null) only
  // if an embedder has no model identity — caching without it could serve
  // another model's vectors.
  const embeddingCache = embedder.modelId
    ? createEmbeddingCache({
        dir: path.join(dataDir, "embeddings-cache"),
        modelId: embedder.modelId,
      })
    : null;
  // Disposable recall index, built lazily + cached, invalidated on every
  // memory write (onWrite) so recall doesn't rebuild + re-embed the corpus
  // per call. References change via the filesystem, not memory writes, but
  // recall only indexes memories, so memory-write invalidation suffices
  // for recall (search_references builds its own index).
  let cachedIndex: Promise<CorpusIndex> | null = null;
  const markdownMemory = createMarkdownMemoryStore({
    vault,
    commit,
    onWrite: () => {
      cachedIndex = null;
    },
  });
  const markdownHandoffs = createMarkdownHandoffStore({ vault, commit });
  const corpusIndex = (): Promise<CorpusIndex> =>
    (cachedIndex ??= buildCorpusIndex(vault, { embedder, cache: embeddingCache }).catch(
      (error: unknown) => {
        cachedIndex = null; // a failed/transient build (e.g. real embedder load) must not poison recall
        throw error;
      },
    ));
  const jsonSettings = createJsonSettingsStore({
    filePath: path.join(dataDir, "settings.json"),
    secretKey: options.secretKey ?? null,
  });
  // Curator read-side over the vault (Phase 4): memory evidence + slice
  // enumeration come from the markdown memory store; run/operation bookkeeping
  // lives in a sidecar JSON file (curation-runs.json).
  const markdownCuration = createJsonCurationStore({
    filePath: path.join(dataDir, "curation-runs.json"),
    memorySource: createVaultGroomingMemorySource(markdownMemory),
  });
  // Intake decision log (spec 043 C1) — the intake's full-outcome sidecar,
  // paralleling curation-runs.json. Purely observational + fail-soft, so it never
  // affects filing; the sweep wires it below. Lives at intake-runs.json; the
  // resolver falls back to a pre-rethink consolidation-runs.json until
  // `migrate-data-dir` renames it (rethink T26, spec §10).
  const markdownIntake = createJsonIntakeStore({
    filePath: resolveIntakeRunsPath(dataDir),
  });
  // The primer read cache (rethink T11): undefined = not yet read this
  // process; null = read and absent (pre-seed); string = the file's content.
  // Updated on writePrimer — every primer write flows through it.
  let cachedPrimer: string | null | undefined;
  // The vault explorer/editor surface (rethink T18/T19). Its mutations ride the
  // same committer; per touched path it invalidates the recall index (any
  // vault file may be a memory) and, when primer.md itself is edited/renamed
  // away, drops the primer cache so the next read hits the file.
  // The history/diff/restore surface (rethink T20/T21) reads the same repo
  // the committer writes; restores write back through this store's own path.
  const gitHistory = createGitHistory({ cwd: vault.root });
  const vaultFiles = createVaultFileStore({
    vault,
    commit,
    history: gitHistory,
    onWrite: (relPath) => {
      cachedIndex = null;
      if (relPath === PRIMER_PATH) cachedPrimer = undefined;
    },
  });
  // Index-backed recall, extracted so the intake's navigate step can
  // reuse the exact same recall the `recall` verb uses.
  const storeRecall = async (input: Record<string, unknown> = {}): Promise<Memory[]> => {
    const query = typeof input.query === "string" ? input.query : "";
    // filter-only (no query) stays on the keyword path
    if (!query.trim()) return markdownMemory.searchMemories(input);
    return recallMemories(
      { index: await corpusIndex(), getMemory: (id) => markdownMemory.getMemory(id) },
      query,
      {
        tags: Array.isArray(input.tags) ? (input.tags as string[]) : undefined,
        limit: typeof input.limit === "number" ? input.limit : undefined,
      },
    );
  };
  return {
    ...markdownMemory,
    ...markdownCuration,
    ...markdownIntake,
    ...jsonSettings,
    handoffs: markdownHandoffs,
    vaultFiles,
    vaultRouter,
    searchReferences: (query, limit) =>
      searchVaultReferences(vault, embedder, query, {
        cache: embeddingCache,
        ...(limit !== undefined ? { limit } : {}),
      }),
    // "references" mirrors corpus-index's REFERENCES_DIR — the exact set
    // searchReferences indexes, so this is a faithful "searched" denominator.
    countReferences: () => vault.listMarkdown("references").length,
    recall: storeRecall,
    submitToInbox: (text: string, hints?: InboxSubmissionHints) => {
      const ref = writeInbox(vault, text, hints ? { hints } : {});
      commit(`inbox: submit ${ref.id}`); // durable + committed instantly
      return ref;
    },
    runIntakeSweep: async (deps): Promise<SweepSummary> => {
      // PERF: each applied item invalidates the recall index (onWrite) and the
      // next item's navigate rebuilds + re-embeds the corpus; listActive also
      // re-reads the vault per item. Correct (later items see earlier filings,
      // S1/G6) but ~O(items) rebuilds — batch/defer index invalidation across a
      // sweep when the real embedder makes this a hot spot. Fine while sweeps
      // are serial + off the hot path.
      const summary = await runIntakeSweep({
        vault,
        recall: (q, n) => storeRecall({ query: q, limit: n }),
        listActive: () => markdownMemory.listAll({ status: MemoryStatus.Active }),
        store: markdownMemory,
        actorId: INTAKE_ACTOR_ID,
        llmClient: deps.llmClient,
        // Observational decision log — fail-soft inside the sweep, never affects filing.
        intakeLog: markdownIntake,
        intakeTrigger: deps.trigger ?? "manual",
        ...(deps.confidenceThreshold !== undefined
          ? { confidenceThreshold: deps.confidenceThreshold }
          : {}),
        ...(deps.lockTtlMs !== undefined ? { lockTtlMs: deps.lockTtlMs } : {}),
        ...(deps.onError ? { onError: deps.onError } : {}),
        ...(deps.promptAddendum ? { promptAddendum: deps.promptAddendum } : {}),
        ...(deps.intakeExamples ? { intakeExamples: deps.intakeExamples } : {}),
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
    vaultActivity: (input = {}) =>
      gitHistory.recentCommits(input).map((entry) => ({
        ...entry,
        source: classifyVaultCommit(entry.subject),
      })),
    vaultCommitDiff: (hash) => gitHistory.commitDiff(hash),
    restoreVaultTo: (hash, options) =>
      restoreVaultToCommit(
        {
          settings: jsonSettings,
          git,
          history: gitHistory,
          // A live curator pass (grooming slice) or intake sweep run record in
          // `running` — restoring under either would corrupt its writes.
          hasRunningCurationRun: () =>
            markdownCuration.listCurationRuns({ status: "running" }).length > 0 ||
            markdownIntake.listIntakeRuns({ status: "running" }).length > 0,
          invalidate: () => {
            cachedIndex = null;
            cachedPrimer = undefined; // primer.md may have changed with the tree
          },
        },
        hash,
        options,
      ),
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
    // The primer lives at vault/primer.md (rethink T11, spec §5.2): same
    // write+commit primitive as the addendums below. Reads are cached
    // in-memory — the text is read per MCP initialize / GET /primer.md — and
    // the cache is refreshed on every write, so an admin edit is served fresh
    // to the next connection without a re-read per request.
    readPrimer: () => {
      if (cachedPrimer === undefined) cachedPrimer = vault.tryReadText(PRIMER_PATH);
      return cachedPrimer;
    },
    writePrimer: (content) => {
      vault.writeText(PRIMER_PATH, content);
      commit("primer: update");
      cachedPrimer = content;
    },
    // Curator addenda live as committed vault files (spec 044 D-1): same
    // write+commit primitive as memory/handoff, read back as raw text (no
    // frontmatter), versioned by the file's last-touching commit hash. The
    // intake examples document (proposal-review rework F4 / D3) is a sibling
    // over the SAME primitives — one committed-file helper serves both.
    readAddendum: (job) => readCuratorFile(addendumPath(job)),
    writeAddendum: (job, content) =>
      writeCuratorFile(addendumPath(job), content, `curator: addendum ${job}`),
    rollbackAddendum: (job) => rollbackCuratorFile(addendumPath(job), `curator: rollback ${job}`),
    readIntakeExamples: () => readCuratorFile(INTAKE_EXAMPLES_PATH),
    writeIntakeExamples: (content) =>
      writeCuratorFile(INTAKE_EXAMPLES_PATH, content, "curator: intake-examples update"),
    rollbackIntakeExamples: () =>
      rollbackCuratorFile(INTAKE_EXAMPLES_PATH, "curator: intake-examples rollback"),
  };

  function readCuratorFile(rel: string): AddendumRecord {
    const content = vault.tryReadText(rel) ?? "";
    // The version is meaningful only when the file actually exists on disk;
    // lastCommitFor would otherwise return null anyway, but skip the git call.
    const version = vault.exists(rel) ? git.lastCommitFor(rel) : null;
    return { content, version };
  }

  function writeCuratorFile(rel: string, content: string, message: string): AddendumRecord {
    vault.writeText(rel, content);
    commit(message);
    return { content, version: git.lastCommitFor(rel) };
  }

  function rollbackCuratorFile(rel: string, message: string): RollbackAddendumResult {
    // The file's own commit history, newest-first. [0] = current version,
    // [1] = the prior version we roll back to.
    const history = git.commitsFor(rel);
    if (history.length === 0) {
      // Never committed — nothing to roll back. Safe no-op.
      return { restored: false, version: null };
    }
    const prior = history[1];
    if (prior) {
      // Restore ONLY this file to its prior committed content (surgical — the
      // vault is the live shared tree), then commit the restoration so it is a
      // revertable commit at the head of the file's history.
      git.checkoutFile(rel, prior);
    } else {
      // Single committed version → no prior content to restore to. Roll back to
      // the pre-existence state by clearing the file, still committed.
      vault.writeText(rel, "");
    }
    commit(message);
    return { restored: true, version: git.lastCommitFor(rel) };
  }
}
