import fs from "node:fs";
import path from "node:path";
import type { Principal } from "../caller-identity.js";
import type { CuratorConsumer } from "../curator-consumers.js";
import type { LlmClient } from "../grooming-llm-client.js";
import { createVaultGroomingMemorySource } from "../grooming-source-vault.js";
import { type SweepSummary, runIntakeSweep } from "../intake/index.js";
import { PRIMER_PATH, type PrimerStore } from "../primer.js";
import { MemoryStatus } from "../schemas/common.js";
import {
  DEFAULT_SHELF,
  ShelfNotInWriteSetError,
  ShelfNotWritableError,
  type Shelf,
  type VaultRouter,
  defaultVaultRouter,
  validateShelfSet,
} from "../vault-router.js";
import {
  type InboxItemRef,
  type InboxSubmissionHints,
  type Vault,
  createVault,
  scopeVault,
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
  /**
   * Clock injection (spec 062 SC 1 — the determinism plumbing, §4 "named API addition").
   * Threaded verbatim to the markdown memory + handoff stores' existing `deps.now`, which
   * defaults to `nowIso`. Its type MATCHES those stores' `now` (`() => string`, an ISO
   * timestamp). This is a pure PASS-THROUGH: absent, every written document stamps
   * `nowIso()` exactly as before — byte-identical. Present, the SC 1 golden layout test
   * feeds a fixed stepping clock so a representative write/groom cycle produces a
   * byte-stable vault tree (without it the comparison flakes on fresh timestamps).
   */
  now?: () => string;
  /**
   * Id generator injection (spec 062 SC 1 — the determinism plumbing). Threaded verbatim to
   * the markdown memory + handoff stores' existing `deps.generateId` (defaults to
   * `makeId("mem")` / `makeId("hdo")` — `randomUUID`-backed). Pure PASS-THROUGH: absent,
   * ids are minted exactly as before. Present, the golden test supplies a sequential
   * generator so the UUIDs-in-filenames stop flaking the byte comparison.
   */
  generateId?: () => string;
  /**
   * TEST SEAM (spec 062 SC 10) — NOT part of the public/extension API. Invoked ONCE with the
   * shelf's prefix each time that shelf's corpus index is actually (re)built via
   * {@link buildCorpusIndex} — i.e. on a cache MISS, never on a cache hit. It observes; it never
   * changes behaviour (absent ⇒ no-op, exactly the now/generateId pass-through discipline). The
   * SC 10 build-counter test injects it to assert the default router does exactly one shelf
   * iteration and at most one build per recall (cache hit on repeat), and the SC 4 test uses the
   * per-prefix argument to prove a write to shelf A rebuilds ONLY A (shelf B's cache survives).
   * Deliberately omitted from the extension-entrypoint docs — it is a measurement hook, not a seam
   * plugins consume.
   */
  onIndexBuild?: (shelfPrefix: string) => void;
}

/**
 * A view of the store CONFINED to one shelf (spec 062 SC 3 / T3, ADR 0011). Its reads, proposals,
 * and writes resolve BENEATH the shelf's prefix — the memory/handoff/reference/inbox layout lands
 * under `<prefix>…`, `routeMemoryWrite`'s landing-status verdict applies unchanged within the
 * shelf, and every mutation still commits through the ONE `commit()` closure into the SINGLE git
 * repo (sidecars — sqlite/settings/embedding cache — stay vault-singular). The DEFAULT shelf's
 * handle (prefix `""`) IS the legacy top-level path: the {@link LibrarianStore}'s own
 * memory/handoff/recall/reference/inbox surface delegates to it, so there is ONE code path with no
 * drift and byte-identical default-router behaviour.
 *
 * A handle bound to a `writable: false` shelf serves reads but REFUSES every write with a
 * {@link ShelfNotWritableError} (spec 062 SC 6). This is the surface T6 (grooming) and T7
 * (Teams-shape restore) consume — the same store surface, scoped down; it exposes no more than
 * what already exists on the store.
 */
export interface ShelfScopedStore extends MemoryStore {
  /** The shelf this handle is confined to (its id/prefix/writable/label). */
  readonly shelf: Shelf;
  /** Handoff read/write confined to `<prefix>handoffs/`. */
  handoffs: HandoffStore;
  /** Vault-file read/write confined to the shelf (path discipline + kinds are shelf-relative). */
  vaultFiles: VaultFileStore;
  /** Index-backed recall over THIS shelf's memories only (merged multi-shelf recall is T5). */
  recall(input?: Record<string, unknown>): Promise<Memory[]>;
  /** Reference lookup over `<prefix>references/` only. */
  searchReferences(query: string, limit?: number): Promise<ReferenceHit[]>;
  /** How many reference documents this shelf holds. */
  countReferences(): number;
  /** Submit raw text to THIS shelf's `<prefix>inbox/` (fire-and-forget, committed instantly). */
  submitToInbox(text: string, hints?: InboxSubmissionHints): InboxItemRef;
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
  /**
   * A store handle CONFINED to `shelf` (spec 062 SC 3 / T3). The DEFAULT shelf (prefix `""`)
   * returns the top-level handle itself — the legacy path, byte-identical. A non-default shelf
   * gets a scoped handle whose paths resolve beneath `<prefix>` and whose writes are refused when
   * `shelf.writable` is false. This is how the system pipelines (grooming/intake, T6) and the
   * Teams-shape restore (T7) get shelf scope — NOT via {@link VaultRouter.writeTarget}, which
   * governs principal-attributed writes only (spec 062 §4).
   */
  forShelf(shelf: Shelf): ShelfScopedStore;
  /**
   * Resolve where a principal's new, self-attributed material lands (spec 062 SC 6). Materialises
   * `router.shelves(principal, "write")` (validated here — the runtime validation point T1's design
   * named for supplied routers), asks the router for `writeTarget(principal)`, and enforces the
   * honest write-routing semantics: the target must be `writable` (else {@link ShelfNotWritableError})
   * AND a member of the write-op set (else {@link ShelfNotInWriteSetError}). With the default router
   * this is the single writable main shelf, byte-identical. Callers pair it with {@link forShelf}.
   */
  resolveWriteTarget(principal: Principal): Shelf;
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
  // Determinism plumbing (spec 062 SC 1): the optional clock/id injections thread through to
  // the two markdown stores that stamp timestamps + mint ids INTO vault files (memories/ and
  // handoffs/). Passed only when supplied so the defaults (`nowIso` / `makeId`) stand under
  // exactOptionalPropertyTypes — with the options absent this is byte-for-byte the old
  // construction. (References carry no store-minted clock/id — they are inert content files —
  // so there is no reference store to thread; the inbox mints its own numeric clock/id via
  // InboxDeps, a different type, and is out of this API's scope, spec 062 §4.)
  const deterministicDeps = {
    ...(options.now ? { now: options.now } : {}),
    ...(options.generateId ? { generateId: options.generateId } : {}),
  };
  const jsonSettings = createJsonSettingsStore({
    filePath: path.join(dataDir, "settings.json"),
    secretKey: options.secretKey ?? null,
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
  // The vault's git history reader (rethink T20/T21) — ONE per repo, shared across every
  // shelf-scoped vault-file store (git is keyed on FULL vault-relative paths, never shelf-relative).
  const gitHistory = createGitHistory({ cwd: vault.root });

  // ── shelf-scoped store handles (spec 062 SC 3 / T3) ─────────────────────────────────────────
  // The load-bearing mechanism: a factory that builds the SAME memory/handoff/reference/inbox
  // surface CONFINED to one shelf, over a shelf-scoped vault view (`scopeVault`). The memory /
  // handoff / inbox / corpus-index / reference sub-stores are subdir-hardcoded (`memories/`,
  // `handoffs/`, `inbox/`, `references/`) and take a `Vault`, so a scoped vault lands their layout
  // beneath `<prefix>` with NO change to them; the vault-file store instead takes the TRUE vault +
  // a `prefix` (it speaks FULL paths to git). Every mutation still flows through the ONE `commit`
  // closure into the SINGLE repo; sidecars stay vault-singular. The DEFAULT shelf (prefix "") makes
  // `scopeVault` an identity, so the main handle IS the legacy path — one code path, no drift.
  interface ShelfHandleOptions {
    /** Extra per-file-write side effect (the main handle drops the primer cache on a primer edit). */
    onFileWrite?: (relPath: string) => void;
  }
  interface ShelfHandle extends ShelfScopedStore {
    /** The (write-gated) memory store, as a single object — the top-level store re-spreads it. */
    readonly memory: MemoryStore;
    /** The un-gated memory store (curation source + intake sweep write through it directly). */
    readonly rawMemory: MemoryStore;
    /** This shelf's scoped vault view (the intake sweep drains its inbox). */
    readonly scopedVault: Vault;
    /** This shelf's lazily-built, cached recall index. */
    corpusIndex(): Promise<CorpusIndex>;
    /** Drop this shelf's cached recall index (fired on every memory/file write). */
    invalidateIndex(): void;
  }
  function buildShelfHandle(shelf: Shelf, opts: ShelfHandleOptions): ShelfHandle {
    const scopedVault = scopeVault(vault, shelf.prefix);
    let cachedIndex: Promise<CorpusIndex> | null = null;
    const invalidateIndex = (): void => {
      cachedIndex = null;
    };
    // Disposable recall index over THIS shelf's memories, built lazily + cached, invalidated on
    // every memory/file write (onWrite) — exactly today's single-index semantics, PER SHELF (each
    // handle owns its own `cachedIndex`, so a write to one shelf leaves the others' caches intact,
    // spec 062 SC 4). The persistent embedding cache is SHARED across shelves (memory-cheap; its
    // records are content-hash-validated and keyed by the FULL vault-relative path via
    // `cacheKeyPrefix`, so shelves stay disjoint). Under the default shelf (prefix "") this is
    // byte-identical to before: one index, one cache, `cacheKeyPrefix` empty.
    const buildIndex = (): Promise<CorpusIndex> => {
      options.onIndexBuild?.(shelf.prefix); // spec 062 SC 10 test seam (non-API): counts real builds
      return buildCorpusIndex(scopedVault, {
        embedder,
        cache: embeddingCache,
        cacheKeyPrefix: shelf.prefix,
      }).catch((error: unknown) => {
        cachedIndex = null; // a failed/transient build must not poison recall
        throw error;
      });
    };
    const corpusIndex = (): Promise<CorpusIndex> => (cachedIndex ??= buildIndex());
    const rawMemory = createMarkdownMemoryStore({
      vault: scopedVault,
      commit,
      onWrite: invalidateIndex,
      ...deterministicDeps,
    });
    const rawHandoffs = createMarkdownHandoffStore({
      vault: scopedVault,
      commit,
      ...deterministicDeps,
    });
    // The vault-file store takes the TRUE vault (full paths to git) + the shelf prefix (T2's
    // shelf-relative path discipline / kinds). Its onWrite invalidates this shelf's index and
    // runs the handle's extra side effect (the main handle's primer-cache drop).
    const rawFiles = createVaultFileStore({
      vault,
      commit,
      history: gitHistory,
      prefix: shelf.prefix,
      onWrite: (relPath) => {
        invalidateIndex();
        opts.onFileWrite?.(relPath);
      },
    });
    // Index-backed recall over this shelf only — the same code the `recall` verb + the intake's
    // navigate step use. Merged multi-shelf recall is T5; this is one shelf.
    const recall = async (input: Record<string, unknown> = {}): Promise<Memory[]> => {
      const query = typeof input.query === "string" ? input.query : "";
      if (!query.trim()) return rawMemory.searchMemories(input); // filter-only stays on keyword
      return recallMemories(
        { index: await corpusIndex(), getMemory: (id) => rawMemory.getMemory(id) },
        query,
        {
          tags: Array.isArray(input.tags) ? (input.tags as string[]) : undefined,
          limit: typeof input.limit === "number" ? input.limit : undefined,
        },
      );
    };
    const searchReferences = (query: string, limit?: number): Promise<ReferenceHit[]> =>
      searchVaultReferences(scopedVault, embedder, query, {
        cache: embeddingCache,
        cacheKeyPrefix: shelf.prefix,
        ...(limit !== undefined ? { limit } : {}),
      });
    // "references" mirrors corpus-index's REFERENCES_DIR — a faithful "searched" denominator.
    const countReferences = (): number => scopedVault.listMarkdown("references").length;
    const rawSubmitToInbox = (text: string, hints?: InboxSubmissionHints): InboxItemRef => {
      const ref = writeInbox(scopedVault, text, hints ? { hints } : {});
      commit(`inbox: submit ${ref.id}`); // durable + committed instantly
      return ref;
    };

    // Write-target enforcement (spec 062 SC 6): a read-only shelf serves reads but REFUSES every
    // write with the typed error. A writable shelf gets the raw sub-stores directly — so the
    // DEFAULT (writable) shelf has zero wrapper overhead and is byte-identical.
    const refuseWrite = (): never => {
      throw new ShelfNotWritableError(shelf);
    };
    const memory: MemoryStore = shelf.writable
      ? rawMemory
      : {
          ...rawMemory,
          createMemory: () => refuseWrite(),
          updateMemory: () => refuseWrite(),
          archiveMemory: () => refuseWrite(),
          unarchiveMemory: () => refuseWrite(),
          purgeMemory: () => refuseWrite(),
          flagMemory: () => refuseWrite(),
          resolveFlags: () => refuseWrite(),
          approveProposal: () => refuseWrite(),
          resolveProposal: () => refuseWrite(),
          bulkUpdateMemory: () => refuseWrite(),
        };
    const handoffs: HandoffStore = shelf.writable
      ? rawHandoffs
      : {
          ...rawHandoffs,
          store: () => refuseWrite(),
          claim: () => refuseWrite(),
          purge: () => refuseWrite(),
        };
    const vaultFiles: VaultFileStore = shelf.writable
      ? rawFiles
      : {
          ...rawFiles,
          writeFile: () => refuseWrite(),
          createFile: () => refuseWrite(),
          renameFile: () => refuseWrite(),
          deleteFile: () => refuseWrite(),
          restoreFileVersion: () => refuseWrite(),
        };
    const submitToInbox = shelf.writable ? rawSubmitToInbox : (): never => refuseWrite();

    return {
      ...memory,
      shelf,
      handoffs,
      vaultFiles,
      recall,
      searchReferences,
      countReferences,
      submitToInbox,
      memory,
      rawMemory,
      scopedVault,
      corpusIndex,
      invalidateIndex,
    };
  }

  // The DEFAULT-shelf handle = the legacy top-level path (prefix "" → identity vault). A primer
  // edit drops the primer read cache; the shared persistent embedding cache is wired inside
  // buildShelfHandle (all shelves share it, keyed by full vault-relative path — spec 062 T4).
  const mainHandle = buildShelfHandle(DEFAULT_SHELF, {
    onFileWrite: (relPath) => {
      if (relPath === PRIMER_PATH) cachedPrimer = undefined;
    },
  });

  // Per-shelf handles, MEMOIZED by prefix (spec 062 T4). Prefix is the stable, content-determining
  // key: it fixes WHICH files the shelf's index covers, validateShelfSet keeps prefixes disjoint,
  // and it is what the persistent cache keys on — two Shelf objects differing only in id/label but
  // sharing a prefix are the SAME shelf of content, so they share the one handle (and its lazily
  // built, separately invalidated index). Memoization is what makes the caching REAL: a second
  // recall on a shelf hits the cached index instead of rebuilding, and a write to shelf A
  // invalidates only A's cached index while B's survives. Seeded with the default-shelf handle so
  // forShelf({ prefix: "" }) is byte-identically the legacy top-level path (one shared instance).
  const handles = new Map<string, ShelfHandle>([["", mainHandle]]);

  /** A store handle confined to `shelf` (spec 062 SC 3 / T4). The default shelf returns the main
   * handle itself; a non-default shelf's handle is built once (its prefix validated before scoping)
   * and memoized by prefix, so its cached index + scoped invalidation persist across calls. */
  const forShelf = (shelf: Shelf): ShelfScopedStore => {
    const existing = handles.get(shelf.prefix);
    if (existing) return existing;
    validateShelfSet([shelf]); // catch a malformed prefix before scopeVault trusts it
    const handle = buildShelfHandle(shelf, {});
    handles.set(shelf.prefix, handle);
    return handle;
  };

  /** Resolve + validate where a principal's new material lands (spec 062 SC 6). */
  const resolveWriteTarget = (principal: Principal): Shelf => {
    // The runtime validation point T1's design named: validate whatever a SUPPLIED router
    // materialises, at first use. The default router's static set already passed at boot.
    const writeShelves = vaultRouter.shelves(principal, "write");
    validateShelfSet(writeShelves);
    const target = vaultRouter.writeTarget(principal);
    if (!target.writable) throw new ShelfNotWritableError(target);
    // Honest write-routing semantics (reported decision): writeTarget MUST be one of the
    // principal's write-op shelves — else the "where writes land" and "what may be written" axes
    // disagree. Matched by id AND prefix (a writable shelf's id is unique per the T1 rules).
    if (!writeShelves.some((s) => s.id === target.id && s.prefix === target.prefix)) {
      throw new ShelfNotInWriteSetError(target, writeShelves);
    }
    return target;
  };

  // Curator read-side over the vault (Phase 4): memory evidence + slice enumeration come from the
  // (default-shelf) markdown memory store; run/operation bookkeeping lives in a sidecar JSON file.
  const markdownCuration = createJsonCurationStore({
    filePath: path.join(dataDir, "curation-runs.json"),
    memorySource: createVaultGroomingMemorySource(mainHandle.rawMemory),
  });
  return {
    ...mainHandle.memory,
    ...markdownCuration,
    ...markdownIntake,
    ...jsonSettings,
    handoffs: mainHandle.handoffs,
    vaultFiles: mainHandle.vaultFiles,
    vaultRouter,
    forShelf,
    resolveWriteTarget,
    searchReferences: mainHandle.searchReferences,
    // "references" mirrors corpus-index's REFERENCES_DIR — the exact set
    // searchReferences indexes, so this is a faithful "searched" denominator.
    countReferences: mainHandle.countReferences,
    recall: mainHandle.recall,
    submitToInbox: mainHandle.submitToInbox,
    runIntakeSweep: async (deps): Promise<SweepSummary> => {
      // PERF: each applied item invalidates the recall index (onWrite) and the
      // next item's navigate rebuilds + re-embeds the corpus; listActive also
      // re-reads the vault per item. Correct (later items see earlier filings,
      // S1/G6) but ~O(items) rebuilds — batch/defer index invalidation across a
      // sweep when the real embedder makes this a hot spot. Fine while sweeps
      // are serial + off the hot path.
      const summary = await runIntakeSweep({
        vault: mainHandle.scopedVault,
        recall: (q, n) => mainHandle.recall({ query: q, limit: n }),
        listActive: () => mainHandle.rawMemory.listAll({ status: MemoryStatus.Active }),
        store: mainHandle.rawMemory,
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
    // drop EVERY shelf's cached recall index → the next recall on each rebuilds from the vault
    // (also picks up out-of-band vault edits, e.g. a hand-added reference). Vault-wide maintenance
    // verb: under the default router there is one handle, so this is byte-identical to before
    // (spec 062 T4 — the per-shelf generalisation of "invalidate the index", no new semantics).
    reindex: () => {
      for (const handle of handles.values()) handle.invalidateIndex();
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
            // A restore replaces the WHOLE working tree, so every shelf's index is stale — drop
            // them all (default router = one handle, byte-identical; spec 062 T4).
            for (const handle of handles.values()) handle.invalidateIndex();
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
