// Git-ops module — the vault's git layer (commit-per-op; `git push` backup
// in Phase 7). Spec 035 §F12.

export { type GitOps, createGitOps } from "./git-ops.js";
