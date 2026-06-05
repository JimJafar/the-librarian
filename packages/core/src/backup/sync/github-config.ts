// Resolve the GitHub backup remote (owner/repo + token) from the settings store
// (dashboard-configured, automated-backups A2/A6) with an env fallback (headless).
// Returns null when not configured. The repo + token build the `git push` remote.
//
// The token is a secret setting (encrypted at rest); reading it needs
// LIBRARIAN_SECRET_KEY, so getSetting may throw — we fall back to env in that case.

import type { LibrarianStore } from "../../store/librarian-store.js";

export interface GithubSyncConfig {
  /** "owner/repo" of the (private) repo the vault is `git push`ed to as a backup. */
  repo: string;
  /** A fine-grained PAT with contents read/write on the repo. */
  token: string;
}

// The backup remote URL is built as `…/${repo}.git`, so the repo must be a bare
// "owner/repo" slug — a full URL or a lone name breaks the push deep in git with a
// confusing message. This pragmatic shape check (a teaching gate at the config
// boundary, not a security boundary) catches the common mistakes early.
const REPO_SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** True when `repo` is a bare "owner/repo" slug (the shape the remote URL expects). */
export function isValidGithubRepoSlug(repo: string): boolean {
  return REPO_SLUG_RE.test(repo);
}

/**
 * The teaching message for a malformed `backup.github.repo`. Echoes the offending
 * value (the repo slug only — never a token) so the reader sees what they typed.
 */
export function githubRepoSlugError(repo: string): string {
  return `Expected "owner/repo" (e.g. "octocat/hello-world"), got ${JSON.stringify(repo)}`;
}

type SettingsReader = Pick<LibrarianStore, "getSetting">;

function readSetting(store: SettingsReader, key: string): string {
  try {
    return store.getSetting(key) ?? "";
  } catch {
    return ""; // secret setting without a master key, or store error → fall back to env
  }
}

export function resolveGithubSyncConfig(
  store: SettingsReader,
  env: NodeJS.ProcessEnv = process.env,
): GithubSyncConfig | null {
  const pick = (settingKey: string, envKey: string): string =>
    readSetting(store, settingKey) || env[envKey] || "";

  const repo = pick("backup.github.repo", "LIBRARIAN_BACKUP_GITHUB_REPO");
  const token = pick("backup.github.token", "LIBRARIAN_BACKUP_GITHUB_TOKEN");
  if (!repo || !token) return null;
  return { repo, token };
}
