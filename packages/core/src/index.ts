export * from "./constants.js";
export {
  type ActorKind,
  type CallerAliasMap,
  type CallerRole,
  type ResolveCallerInput,
  type ResolvedCaller,
  SYSTEM_ACTOR_IDS,
  actorKind,
  isReservedId,
  normaliseCallerId,
  resolveCaller,
  toCanonicalId,
} from "./caller-identity.js";
export { type CallerIdAudit, type CallerIdGroup, auditCallerIds } from "./caller-audit.js";
export {
  type TombstoneRef,
  contentFingerprint,
  curationContentFingerprint,
  curationNormalizedTitle,
  matchesTombstone,
  normalizeForFingerprint,
  normalizedTitle,
} from "./curator-fingerprint.js";
export { type RedactionResult, redactSecrets } from "./curator-redaction.js";
export {
  type PrepassFinding,
  type PrepassFindingKind,
  type PrepassResult,
  deterministicPrepass,
} from "./curator-prepass.js";
export { type CuratorPromptInput, buildCuratorPrompt } from "./curator-prompt.js";
export {
  type CuratorMemoryInput,
  type CuratorMemoryPatch,
  type CuratorOperation,
  type ParsedCuratorOutput,
  type RejectedOperation,
  CuratorOperationSchema,
  parseCuratorOutput,
} from "./curator-output.js";
export {
  type OperationOutcome,
  type RiskLevel,
  type ValidatedOperation,
  type ValidationContext,
  validateOperations,
} from "./curator-validate.js";
export {
  type AcceptedClassification,
  type ApplyDecision,
  type ApplyPolicy,
  decideApply,
} from "./curator-apply-policy.js";
export {
  type ApplyDeps,
  type ApplyStore,
  type ApplySummary,
  applyOperations,
} from "./curator-apply.js";
export { type RunCurationCaps, type RunCurationOptions, runCuration } from "./curator-worker.js";
export {
  type DueDecision,
  type DueReason,
  type ScheduleConfig,
  type SliceState,
  isIntervalDue,
  isSliceDue,
  nextScheduledRun,
} from "./curator-schedule.js";
export { findLegacyScheduleKeys } from "./curator-config.js";
export { type CurationRunReader, type DueSlice, selectDueSlices } from "./curator-scheduler.js";
export {
  type CuratorTrigger,
  type RunDueCurationOptions,
  type RunDueCurationSummary,
  runDueCuration,
} from "./curator-enqueue.js";
export {
  type CuratorTickOptions,
  type CuratorTickResult,
  type CuratorTickSkipReason,
  runCuratorTick,
} from "./curator-tick.js";
export {
  type ConsolidatorTickOptions,
  type ConsolidatorTickResult,
  type ConsolidatorTickSkipReason,
  runConsolidatorTick,
} from "./consolidator-tick.js";
export {
  type SerialScheduler,
  type SerialSchedulerOptions,
  createSerialScheduler,
} from "./serial-scheduler.js";
export {
  type CuratorMemoryRecord,
  type CuratorMemorySource,
  type CuratorTombstoneRecord,
  type EvidenceSlice,
  type MemoryEvidenceBundle,
  type MemoryEvidenceCaps,
  type MemoryEvidenceItem,
  type SliceKind,
  type TombstoneItem,
  gatherMemoryEvidence,
} from "./curator-evidence.js";
export { createSqliteCuratorMemorySource } from "./curator-source-sqlite.js";
export {
  type CuratorVaultMemoryReader,
  createVaultCuratorMemorySource,
} from "./curator-source-vault.js";
export {
  type ApplyConsolidationDeps,
  type BuildConsolidatorPromptInput,
  type ConsolidateInboxItemDeps,
  type ConsolidateResult,
  type ConsolidationCandidates,
  type ConsolidationDecision,
  type ConsolidationJudgment,
  type ConsolidationOutcome,
  type ConsolidationPlan,
  type ConsolidationThresholds,
  type ConsolidatorApplyStore,
  type ConsolidatorStoredMemory,
  type ConsolidatorSweepDeps,
  type ConsolidatorTocEntry,
  type JudgeSubmissionDeps,
  type JudgeSubmissionInput,
  type JudgeSubmissionResult,
  type NavigateDeps,
  type NavigateOptions,
  type ParsedConsolidationJudgment,
  type SweepSummary,
  CONSOLIDATOR_PROMPT_VERSION,
  ConsolidationJudgmentSchema,
  applyConsolidationPlan,
  augmentBody,
  buildConsolidatorPrompt,
  consolidateInboxItem,
  judgeSubmission,
  navigateInbox,
  parseConsolidationJudgment,
  preservesOriginal,
  routeConsolidation,
  runConsolidatorSweep,
} from "./consolidator/index.js";
export {
  type LlmClient,
  type LlmClientConfig,
  type LlmClientDeps,
  type LlmCompletion,
  type LlmCompletionRequest,
  type LlmErrorKind,
  type LlmMessage,
  type LlmRole,
  type LlmUsage,
  LlmClientError,
  createCuratorLlmClient,
} from "./curator-llm-client.js";
export {
  type FileIo,
  type LoadedSecretKey,
  decryptSecret,
  encryptSecret,
  loadOrCreateSecretKeyFile,
  resolveOptionalSecretKey,
  resolveSecretKey,
} from "./secret-crypto.js";
export {
  type AutoApplyLevel,
  type CuratorConfig,
  type CuratorConfigPatch,
  CuratorConfigPatchSchema,
  readCuratorConfig,
  resolveCuratorToken,
  writeCuratorConfig,
} from "./curator-config.js";
export {
  type LlmConnection,
  type LlmConnectionKeys,
  type LlmConnectionPatch,
  type LlmConnectionReader,
  type LlmConnectionWriter,
  LlmConnectionPatchSchema,
  llmConnectionKeys,
  readLlmConnection,
  resolveLlmToken,
  writeLlmConnection,
} from "./llm-connection.js";
export {
  type BackfillChange,
  type BackfillOptions,
  type BackfillSection,
  type CallerBackfillReport,
  backfillCallerIds,
} from "./caller-backfill.js";
export { formatRecall } from "./formatters/index.js";
export {
  type CorpusDocument,
  type CorpusFrontmatter,
  type InboxDeps,
  type InboxItem,
  type InboxItemRef,
  type InboxSubmissionHints,
  type Vault,
  type VaultOptions,
  type Wikilink,
  CorpusFrontmatterSchema,
  claimInboxItem,
  completeInboxItem,
  createVault,
  listInbox,
  parseDocument,
  parseInboxItem,
  parseWikilinks,
  releaseStaleClaims,
  relinkVault,
  renameWikilinkTarget,
  resolveVaultPath,
  serializeDocument,
  serializeInboxItem,
  writeInbox,
} from "./store/corpus/index.js";
export {
  type GitOps,
  type GitPushAuth,
  type SyncGitOps,
  cloneVaultBackup,
  createGitOps,
  createSyncGitOps,
} from "./store/git/index.js";
export {
  type Embedder,
  type HybridHit,
  type HybridIndex,
  type KeywordHit,
  type KeywordIndex,
  type IndexNamespace,
  type LinkGraph,
  type LinkGraphOptions,
  type LlamaEmbedderOptions,
  type NamespacedDoc,
  type NamespacedIndex,
  type RecallDeps,
  type RecallOptions,
  type RecalledDoc,
  type ReferenceHit,
  type ResolveEmbedderOptions,
  type VectorHit,
  type VectorIndex,
  buildHybridIndex,
  buildKeywordIndex,
  buildLinkGraph,
  buildVectorIndex,
  cosineSimilarity,
  createCachingEmbedder,
  createHashEmbedder,
  createLlamaEmbedder,
  createNamespacedIndex,
  extractRelevantSection,
  recallFromIndex,
  resolveEmbedder,
  truncateToTokenLimit,
} from "./store/index/index.js";
export {
  type MarkdownHandoffStoreDeps,
  type MarkdownMemoryStoreDeps,
  createMarkdownHandoffStore,
  createMarkdownMemoryStore,
  parseHandoffDocument,
  parseMemoryDocument,
  serializeHandoffDocument,
  serializeMemoryDocument,
} from "./store/markdown/index.js";
export {
  type JsonConversationStateStoreDeps,
  type JsonSettingsStoreDeps,
  createJsonConversationStateStore,
  createJsonCurationStore,
  createJsonSettingsStore,
} from "./store/sidecar/index.js";
export {
  type SkillDetail,
  type SkillDocument,
  type SkillFrontmatter,
  type SkillManifestEntry,
  type SkillSearchHit,
  type SkillStore,
  SkillFrontmatterSchema,
  createSkillStore,
  findSkills,
  parseSkillDocument,
} from "./store/skills/index.js";
export {
  type CorpusIndexOptions,
  type RecallMemoriesDeps,
  type RecallMemoriesOptions,
  buildCorpusIndex,
  recallMemories,
  searchReferences,
} from "./store/corpus-index.js";
export { type MemoryWriteVerdict, routeMemoryWrite } from "./store/memory-routing.js";
export type { Memory, MemoryStore, MemoryStoreDeps } from "./store/memory-store.js";
export {
  type ConsolidateInboxOptions,
  type InternalLibrarianStore,
  type LibrarianStore,
  type LibrarianStoreOptions,
  type StorageBackend,
  BACKUP_REQUIRES_MARKDOWN,
  createLibrarianStore,
  resolveBackend,
  resolveDataDir,
} from "./store/librarian-store.js";
export {
  type ApplyRestoreResult,
  type StageRestoreResult,
  PRE_RESTORE_BAK,
  RESTORE_FAILED_MARKER,
  RESTORE_MARKER,
  applyPendingRestore,
  stageRestore,
} from "./backup/restore-staging.js";
// Portable data export (distinct from backup — a human/tool-readable dump).
export { type ExportFormat, exportData } from "./backup/export.js";
export { type GithubSyncConfig, resolveGithubSyncConfig } from "./backup/sync/github-config.js";
export { type RunBackupResult, runBackup, runBackupTick } from "./backup/run.js";
export {
  type BackupConfig,
  type BackupConfigPatch,
  type BackupRemote,
  BACKUP_BRANCH,
  BackupConfigPatchSchema,
  readBackupConfig,
  resolveBackupRemote,
  writeBackupConfig,
} from "./backup/config.js";
export {
  type BackupRun,
  type BackupRunStatus,
  type BackupRunTrigger,
  BACKUP_RUNS_FILE,
  latestTerminalBackupRun,
  listBackupRuns,
  lastSuccessfulBackupRun,
} from "./backup/runs.js";
export {
  type AgentTokenMeta,
  type CreatedAgentToken,
  createAgentToken,
  listAgentTokens,
  revokeAgentToken,
  verifyAgentToken,
} from "./auth/agent-tokens.js";
export {
  type LoadedAdminToken,
  loadOrCreateAdminTokenFile,
  parseAdminToken,
} from "./auth/admin-token.js";
export {
  type BootCredentialSignal,
  type BootCredentialsInput,
  type CredentialSource,
  type ResolvedBootCredentials,
  resolveBootCredentials,
} from "./auth/boot-credentials.js";
export {
  type AuthConfig,
  type AuthMethod,
  type AuthStatus,
  type EnableAuthInput,
  type EnableAuthResult,
  type OAuthClient,
  type OAuthProvider,
  deriveAuthSecret,
  enableAuth,
  getAuthConfig,
  getAuthStatus,
  isAuthConfigComplete,
  setEnabled,
  setOAuth,
  setOwner,
} from "./auth/auth-config.js";
export {
  type LockoutState,
  type OwnerAuthResult,
  type SettingsLike,
  LOCKOUT_KEY,
  PASSWORD_KEY,
  assertPasswordPolicy,
  authenticateOwner,
  consumeSetupLink,
  getLockoutState,
  hasOwnerPassword,
  mintSetupLink,
  ownerPasswordUsername,
  resetLockout,
  setOwnerPassword,
  verifyOwnerPassword,
} from "./auth/password.js";
export {
  type CompleteCurationRunInput,
  type CreateCurationRunInput,
  type CurationOperation,
  type CurationRun,
  type CurationStore,
  type FailCurationRunInput,
  type ListCurationRunsInput,
  type RecordCurationOperationInput,
  createSqliteCurationRunReader,
} from "./store/curation-store.js";
export {
  type SettingMeta,
  type SettingsStore,
  createSettingsStore,
} from "./store/settings-store.js";
export {
  type ConversationStateStore,
  createConversationStateStore,
} from "./store/conversation-state-store.js";
export type { ConversationState, ConversationStatePatch } from "./schemas/conversation-state.js";
export { renderConvStateBlock } from "./conv-state-render.js";
export { MemoryEventType } from "./schemas/common.js";
export {
  type ClaimHandoffInput,
  type ClaimHandoffOutput,
  type HandoffSummary,
  type ListHandoffsInput,
  type ListHandoffsOutput,
  type StoreHandoffInput,
  type StoreHandoffOutput,
  ClaimHandoffInputSchema,
  ClaimHandoffOutputSchema,
  HandoffSummarySchema,
  HANDOFF_REQUIRED_HEADINGS,
  ListHandoffsInputSchema,
  ListHandoffsOutputSchema,
  StoreHandoffInputSchema,
  StoreHandoffOutputSchema,
} from "./schemas/handoff.js";
export {
  type ClaimedBy,
  type HandoffDetail,
  type HandoffStore,
  type ListHandoffsContext,
  type StoreHandoffContext,
  createHandoffStore,
  HandoffAlreadyClaimedError,
  HandoffNotFoundError,
} from "./store/handoff-store.js";
