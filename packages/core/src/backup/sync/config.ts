// Resolve S3-compatible sync config from the settings store (dashboard-configured,
// B4) with an env fallback (headless). Returns null when not configured.
//
// Credentials are secret settings (encrypted at rest); reading them needs
// LIBRARIAN_SECRET_KEY, so getSetting may throw — we fall back to env in that case.

import type { LibrarianStore } from "../../store/librarian-store.js";

export interface S3SyncConfig {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  endpoint?: string;
  prefix?: string;
}

type SettingsReader = Pick<LibrarianStore, "getSetting">;

function readSetting(store: SettingsReader, key: string): string {
  try {
    return store.getSetting(key) ?? "";
  } catch {
    return ""; // secret setting without a master key, or store error → fall back to env
  }
}

export function resolveS3SyncConfig(
  store: SettingsReader,
  env: NodeJS.ProcessEnv = process.env,
): S3SyncConfig | null {
  const pick = (settingKey: string, envKey: string): string =>
    readSetting(store, settingKey) || env[envKey] || "";

  const bucket = pick("backup.s3.bucket", "LIBRARIAN_BACKUP_S3_BUCKET");
  const accessKeyId = pick("backup.s3.access_key", "LIBRARIAN_BACKUP_S3_ACCESS_KEY");
  const secretAccessKey = pick("backup.s3.secret_key", "LIBRARIAN_BACKUP_S3_SECRET_KEY");
  if (!bucket || !accessKeyId || !secretAccessKey) return null;

  const config: S3SyncConfig = { bucket, accessKeyId, secretAccessKey };
  const region = pick("backup.s3.region", "LIBRARIAN_BACKUP_S3_REGION");
  const endpoint = pick("backup.s3.endpoint", "LIBRARIAN_BACKUP_S3_ENDPOINT");
  const prefix = pick("backup.s3.prefix", "LIBRARIAN_BACKUP_S3_PREFIX");
  if (region) config.region = region;
  if (endpoint) config.endpoint = endpoint;
  if (prefix) config.prefix = prefix;
  return config;
}
