// Resolve the GitHub backup remote (owner/repo + token) from the settings store
// (dashboard-configured, automated-backups A2/A6) with an env fallback (headless).
// Returns null when not configured. The repo + token build the `git push` remote.
//
// The token is a secret setting (encrypted at rest); reading it needs
// LIBRARIAN_SECRET_KEY, so getSetting may throw — we fall back to env in that case.

import type { LibrarianStore } from "../../store/librarian-store.js";

export interface GithubSyncConfig {
  /** "owner/repo" of a (private) repo whose Releases hold the backup bundles. */
  repo: string;
  /** A fine-grained PAT with contents read/write on the repo. */
  token: string;
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
