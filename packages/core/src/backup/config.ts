// Backup schedule + alert config (automated-backups A3), stored in the admin
// settings store so the dashboard can change it without a redeploy. The scheduler
// tick self-gates on `enabled`; a backup `git push`es the vault to the GitHub
// remote configured by `backup.github.{repo,token}`; `webhookUrl` (optional) is
// POSTed on a failed run.
//
// Back-compat: a headless install that set the legacy `LIBRARIAN_BACKUP_INTERVAL_MS`
// env var (016 B4) and never touched the dashboard keeps working — when no
// `backup.schedule.*` setting exists, the env var supplies enabled + interval.

import { z } from "zod";
import type { GitPushAuth } from "../store/git/index.js";
import type { LibrarianStore } from "../store/librarian-store.js";
import { resolveGithubSyncConfig } from "./sync/github-config.js";

const KEYS = {
  enabled: "backup.schedule.enabled",
  intervalMinutes: "backup.schedule.interval_minutes",
  webhookUrl: "backup.alert.webhook_url",
} as const;

const DEFAULT_INTERVAL_MINUTES = 1440; // daily
const MIN_INTERVAL_MINUTES = 1;

/** The branch the vault is pushed to on the backup remote. */
export const BACKUP_BRANCH = "main";

export interface BackupConfig {
  /** Whether the scheduler runs backups on a cadence. */
  enabled: boolean;
  /** Whole minutes between scheduled backups (>= 1). */
  intervalMinutes: number;
  /** Failure-alert webhook URL ('' = disabled). */
  webhookUrl: string;
}

type SettingsReader = Pick<LibrarianStore, "getSetting">;
type SettingsWriter = Pick<LibrarianStore, "setSetting">;

function readSetting(store: SettingsReader, key: string): string | null {
  try {
    return store.getSetting(key);
  } catch {
    return null; // plain setting read failures degrade to "unset"
  }
}

function parsePositiveInt(value: string | null, fallback: number, min: number): number {
  if (value === null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) && n >= min ? n : fallback;
}

// The schedule setting wins; otherwise the legacy env interval (when it's driving
// `enabled`); otherwise the default cadence.
function resolveIntervalMinutes(
  intervalSetting: string | null,
  legacyEnabled: boolean,
  legacyMs: number,
): number {
  if (intervalSetting !== null) {
    return parsePositiveInt(intervalSetting, DEFAULT_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES);
  }
  if (legacyEnabled) return Math.max(MIN_INTERVAL_MINUTES, Math.round(legacyMs / 60_000));
  return DEFAULT_INTERVAL_MINUTES;
}

export function readBackupConfig(
  store: SettingsReader,
  env: NodeJS.ProcessEnv = process.env,
): BackupConfig {
  const enabledSetting = readSetting(store, KEYS.enabled);
  const intervalSetting = readSetting(store, KEYS.intervalMinutes);

  // Legacy fallback: env interval drives enabled + cadence only when the dashboard
  // has never configured a schedule.
  const legacyMs = Number(env.LIBRARIAN_BACKUP_INTERVAL_MS ?? 0);
  const legacyEnabled = enabledSetting === null && Number.isFinite(legacyMs) && legacyMs > 0;

  const enabled = enabledSetting === null ? legacyEnabled : enabledSetting === "true";

  return {
    enabled,
    intervalMinutes: resolveIntervalMinutes(intervalSetting, legacyEnabled, legacyMs),
    webhookUrl: readSetting(store, KEYS.webhookUrl) ?? "",
  };
}

export interface BackupRemote {
  /** "owner/repo" the vault is pushed to (for display + run records). */
  repo: string;
  /** Auth + URL for the push — token-safe (URL carries only the username). */
  auth: GitPushAuth;
}

/**
 * Resolve the push target from the `backup.github.{repo,token}` settings (or the
 * legacy env vars), or null when no remote is configured. The remote URL carries
 * only the `x-access-token@` username; the token is handed to git via GIT_ASKPASS.
 */
export function resolveBackupRemote(
  store: SettingsReader,
  env: NodeJS.ProcessEnv = process.env,
): BackupRemote | null {
  const gh = resolveGithubSyncConfig(store, env);
  if (!gh) return null;
  return {
    repo: gh.repo,
    auth: {
      remoteUrl: `https://x-access-token@github.com/${gh.repo}.git`,
      branch: BACKUP_BRANCH,
      token: gh.token,
    },
  };
}

export const BackupConfigPatchSchema = z.strictObject({
  enabled: z.boolean().optional(),
  intervalMinutes: z.number().int().min(MIN_INTERVAL_MINUTES).optional(),
  webhookUrl: z.string().optional(),
});
export type BackupConfigPatch = z.infer<typeof BackupConfigPatchSchema>;

export function writeBackupConfig(store: SettingsWriter, patch: BackupConfigPatch): void {
  const p = BackupConfigPatchSchema.parse(patch);
  if (p.webhookUrl && !/^https?:\/\//i.test(p.webhookUrl)) {
    throw new Error(
      `webhook URL must start with http:// or https://, got ${JSON.stringify(p.webhookUrl)}`,
    );
  }
  if (p.enabled !== undefined) store.setSetting(KEYS.enabled, p.enabled ? "true" : "false");
  if (p.intervalMinutes !== undefined) {
    store.setSetting(KEYS.intervalMinutes, String(p.intervalMinutes));
  }
  if (p.webhookUrl !== undefined) store.setSetting(KEYS.webhookUrl, p.webhookUrl);
}
