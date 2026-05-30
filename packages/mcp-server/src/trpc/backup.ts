// Backup admin tRPC procedures: trigger a backup, list recent bundles + run
// health, read/update the schedule + both cloud targets' config, and stage a
// restore / restart. All admin-gated. Config reads never return secret values —
// only whether each is set.

import fs from "node:fs";
import path from "node:path";
import type { BackupConfigPatch, LibrarianStore } from "@librarian/core";
import {
  lastSuccessfulBackupRun,
  latestTerminalBackupRun,
  listBackupRuns,
  readBackupConfig,
  runBackup,
  stageRestore,
  writeBackupConfig,
} from "@librarian/core";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

const LIST_LIMIT = 10;

function backupDestDir(store: LibrarianStore): string {
  return process.env.LIBRARIAN_BACKUP_DIR || path.join(store.dataDir, "backups");
}

const SetConfigSchema = z.strictObject({
  // Schedule / retention / alerting (validated by writeBackupConfig).
  enabled: z.boolean().optional(),
  intervalMinutes: z.number().int().min(1).optional(),
  target: z.enum(["local", "s3", "github"]).optional(),
  retentionKeep: z.number().int().min(1).optional(),
  webhookUrl: z.string().optional(),
  // Cloud-target credentials (secrets write-only — empty/absent leaves them).
  s3: z
    .strictObject({
      bucket: z.string().optional(),
      region: z.string().optional(),
      endpoint: z.string().optional(),
      prefix: z.string().optional(),
      accessKey: z.string().optional(),
      secretKey: z.string().optional(),
    })
    .optional(),
  github: z
    .strictObject({
      repo: z.string().optional(),
      token: z.string().optional(),
    })
    .optional(),
});

export const backupRouter = router({
  createNow: adminProcedure.mutation(async ({ ctx }) => {
    const result = await runBackup(ctx.store, {
      destDir: backupDestDir(ctx.store),
      trigger: "manual",
    });
    return {
      dir: result.dir,
      files: result.manifest.files.length,
      schema_version: result.manifest.schema_version,
      synced: result.synced,
      pruned: result.pruned?.length ?? 0,
    };
  }),

  // The most-recent bundles on disk (capped), newest first.
  list: adminProcedure.query(({ ctx }) => {
    const dir = backupDestDir(ctx.store);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((name) => name.startsWith("librarian-backup-"))
      .map((name) => ({
        name,
        created_at: fs.statSync(path.join(dir, name)).mtime.toISOString(),
        restorable: true,
      }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, LIST_LIMIT);
  }),

  // Recent backup run health (status, target, bytes, error, timestamps).
  runs: adminProcedure
    .input(z.strictObject({ limit: z.number().int().positive().max(100).optional() }).optional())
    .query(({ ctx, input }) => listBackupRuns(ctx.store, input?.limit ?? LIST_LIMIT)),

  // Non-secret config view + health summary. Never returns a secret value.
  config: adminProcedure.query(({ ctx }) => {
    const cfg = readBackupConfig(ctx.store);
    const settingKeys = new Set(ctx.store.listSettings().map((s) => s.key));
    return {
      enabled: cfg.enabled,
      intervalMinutes: cfg.intervalMinutes,
      target: cfg.target,
      retentionKeep: cfg.retentionKeep,
      webhookUrl: cfg.webhookUrl,
      s3: {
        bucket: ctx.store.getSetting("backup.s3.bucket") ?? "",
        region: ctx.store.getSetting("backup.s3.region") ?? "",
        endpoint: ctx.store.getSetting("backup.s3.endpoint") ?? "",
        prefix: ctx.store.getSetting("backup.s3.prefix") ?? "",
        hasAccessKey: settingKeys.has("backup.s3.access_key"),
        hasSecretKey: settingKeys.has("backup.s3.secret_key"),
      },
      github: {
        repo: ctx.store.getSetting("backup.github.repo") ?? "",
        hasToken: settingKeys.has("backup.github.token"),
      },
      // The last *terminal* run drives the failure banner (an in-flight run isn't a
      // failure); lastSuccess drives the green "last backup" line.
      lastRun: latestTerminalBackupRun(ctx.store),
      lastSuccess: lastSuccessfulBackupRun(ctx.store),
    };
  }),

  setConfig: adminProcedure.input(SetConfigSchema).mutation(({ ctx, input }) => {
    const patch: BackupConfigPatch = {};
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.intervalMinutes !== undefined) patch.intervalMinutes = input.intervalMinutes;
    if (input.target !== undefined) patch.target = input.target;
    if (input.retentionKeep !== undefined) patch.retentionKeep = input.retentionKeep;
    if (input.webhookUrl !== undefined) patch.webhookUrl = input.webhookUrl;
    writeBackupConfig(ctx.store, patch);

    if (input.s3) {
      const plain: Record<string, string | undefined> = {
        "backup.s3.bucket": input.s3.bucket,
        "backup.s3.region": input.s3.region,
        "backup.s3.endpoint": input.s3.endpoint,
        "backup.s3.prefix": input.s3.prefix,
      };
      for (const [key, value] of Object.entries(plain)) {
        if (value !== undefined) ctx.store.setSetting(key, value);
      }
      // Empty string leaves a secret unchanged (the form never round-trips it).
      if (input.s3.accessKey)
        ctx.store.setSetting("backup.s3.access_key", input.s3.accessKey, { secret: true });
      if (input.s3.secretKey)
        ctx.store.setSetting("backup.s3.secret_key", input.s3.secretKey, { secret: true });
    }

    if (input.github) {
      if (input.github.repo !== undefined)
        ctx.store.setSetting("backup.github.repo", input.github.repo);
      if (input.github.token)
        ctx.store.setSetting("backup.github.token", input.github.token, { secret: true });
    }

    return { ok: true };
  }),

  // Stage a restore: validate the chosen bundle (pulling from the cloud target if
  // it's not local) and write the pending-restore marker. It is APPLIED on the next
  // boot — never under the live DB connection. The cockpit then prompts a restart.
  stageRestore: adminProcedure
    .input(z.strictObject({ bundle: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      stageRestore(ctx.store, { bundleName: input.bundle, backupDir: backupDestDir(ctx.store) }),
    ),

  // Exit the server so the supervisor/orchestrator restarts it (applying any staged
  // restore on boot). The cockpit's "Restart now" button warns that this only
  // recovers under an auto-restart supervisor. The exit is deferred so the
  // { restarting: true } ack flushes first — best-effort: a dropped ack is harmless
  // here (the caller asked to restart; the server going down IS the outcome).
  restart: adminProcedure.mutation(() => {
    setTimeout(() => process.exit(0), 250);
    return { restarting: true as const };
  }),
});
