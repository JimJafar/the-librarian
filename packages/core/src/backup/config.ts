// Backup schedule + retention + alert config (automated-backups A3), stored in
// the admin settings table so the dashboard can change it without a redeploy.
// The scheduler tick self-gates on `enabled`; `target` selects the cloud sync
// destination; `retentionKeep` bounds how many bundles are kept (pruned in A4);
// `webhookUrl` (optional) is POSTed on a failed run.
//
// Back-compat: a headless install that set the legacy `LIBRARIAN_BACKUP_INTERVAL_MS`
// env var (016 B4) and never touched the dashboard keeps working — when no
// `backup.schedule.*` setting exists, the env var supplies enabled + interval.

import { z } from "zod";
import type { LibrarianStore } from "../store/librarian-store.js";
import { resolveS3SyncConfig } from "./sync/config.js";
import { resolveGithubSyncConfig } from "./sync/github-config.js";

const KEYS = {
  enabled: "backup.schedule.enabled",
  intervalMinutes: "backup.schedule.interval_minutes",
  target: "backup.target",
  retentionKeep: "backup.retention.keep",
  webhookUrl: "backup.alert.webhook_url",
} as const;

const DEFAULT_INTERVAL_MINUTES = 1440; // daily
const MIN_INTERVAL_MINUTES = 1;
const DEFAULT_RETENTION_KEEP = 14;
const MIN_RETENTION_KEEP = 1;

export type BackupTargetSelection = "local" | "s3" | "github";
const TARGET_SELECTIONS: readonly BackupTargetSelection[] = ["local", "s3", "github"];

export interface BackupConfig {
  /** Whether the scheduler runs backups on a cadence. */
  enabled: boolean;
  /** Whole minutes between scheduled backups (>= 1). */
  intervalMinutes: number;
  /** Cloud sync destination ('local' = no cloud sync). */
  target: BackupTargetSelection;
  /** How many bundles to keep per target before pruning (A4). */
  retentionKeep: number;
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

// 'local'|'s3'|'github' when explicitly set; otherwise inferred from which cloud
// credentials are present (back-compat for env-only S3/GitHub setups).
function resolveTargetSelection(
  store: SettingsReader,
  explicit: string | null,
  env: NodeJS.ProcessEnv,
): BackupTargetSelection {
  if (explicit && (TARGET_SELECTIONS as readonly string[]).includes(explicit)) {
    return explicit as BackupTargetSelection;
  }
  if (resolveS3SyncConfig(store, env)) return "s3";
  if (resolveGithubSyncConfig(store, env)) return "github";
  return "local";
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
  const intervalMinutes =
    intervalSetting !== null
      ? parsePositiveInt(intervalSetting, DEFAULT_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES)
      : legacyEnabled
        ? Math.max(MIN_INTERVAL_MINUTES, Math.round(legacyMs / 60_000))
        : DEFAULT_INTERVAL_MINUTES;

  return {
    enabled,
    intervalMinutes,
    target: resolveTargetSelection(store, readSetting(store, KEYS.target), env),
    retentionKeep: parsePositiveInt(
      readSetting(store, KEYS.retentionKeep),
      DEFAULT_RETENTION_KEEP,
      MIN_RETENTION_KEEP,
    ),
    webhookUrl: readSetting(store, KEYS.webhookUrl) ?? "",
  };
}

export const BackupConfigPatchSchema = z.strictObject({
  enabled: z.boolean().optional(),
  intervalMinutes: z.number().int().min(MIN_INTERVAL_MINUTES).optional(),
  target: z.enum(["local", "s3", "github"]).optional(),
  retentionKeep: z.number().int().min(MIN_RETENTION_KEEP).optional(),
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
  if (p.target !== undefined) store.setSetting(KEYS.target, p.target);
  if (p.retentionKeep !== undefined) store.setSetting(KEYS.retentionKeep, String(p.retentionKeep));
  if (p.webhookUrl !== undefined) store.setSetting(KEYS.webhookUrl, p.webhookUrl);
}
