// Git-ops module — the vault's git layer (commit-per-op; `git push` backup
// in Phase 7). Spec 035 §F12.

export {
  type AuditCommit,
  type AuditReadResult,
  type CommitDiff,
  type CommitDiffFile,
  type FileCommit,
  type GitHistory,
  type GitHistoryFileDiffOptions,
  type VaultCommit,
  GitHashError,
  assertCommitHash,
  createGitHistory,
} from "./git-history.js";
export {
  type GitPushAuth,
  type SyncGitOps,
  cloneVaultBackup,
  createSyncGitOps,
} from "./sync-git-ops.js";
