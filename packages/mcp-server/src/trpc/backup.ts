// Backup admin tRPC procedures: trigger a backup now, list recent backups, and
// read/update the cloud-sync config. All admin-gated. The config read never
// returns the secret credentials — only whether they are set.

import fs from "node:fs";
import path from "node:path";
import type { LibrarianStore } from "@librarian/core";
import { runBackup, stageRestore } from "@librarian/core";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

function backupDestDir(store: LibrarianStore): string {
  return process.env.LIBRARIAN_BACKUP_DIR || path.join(store.dataDir, "backups");
}

const SetConfigSchema = z.strictObject({
  bucket: z.string().optional(),
  region: z.string().optional(),
  endpoint: z.string().optional(),
  prefix: z.string().optional(),
  accessKey: z.string().optional(),
  secretKey: z.string().optional(),
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
    };
  }),

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
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }),

  // Non-secret view + whether credentials are configured (never the values).
  config: adminProcedure.query(({ ctx }) => {
    const settingKeys = new Set(ctx.store.listSettings().map((s) => s.key));
    return {
      bucket: ctx.store.getSetting("backup.s3.bucket") ?? "",
      region: ctx.store.getSetting("backup.s3.region") ?? "",
      endpoint: ctx.store.getSetting("backup.s3.endpoint") ?? "",
      prefix: ctx.store.getSetting("backup.s3.prefix") ?? "",
      hasAccessKey: settingKeys.has("backup.s3.access_key"),
      hasSecretKey: settingKeys.has("backup.s3.secret_key"),
    };
  }),

  setConfig: adminProcedure.input(SetConfigSchema).mutation(({ ctx, input }) => {
    const plain: Record<string, string | undefined> = {
      "backup.s3.bucket": input.bucket,
      "backup.s3.region": input.region,
      "backup.s3.endpoint": input.endpoint,
      "backup.s3.prefix": input.prefix,
    };
    for (const [key, value] of Object.entries(plain)) {
      if (value !== undefined) ctx.store.setSetting(key, value);
    }
    // Empty string leaves a secret unchanged (the form never round-trips it).
    if (input.accessKey)
      ctx.store.setSetting("backup.s3.access_key", input.accessKey, { secret: true });
    if (input.secretKey)
      ctx.store.setSetting("backup.s3.secret_key", input.secretKey, { secret: true });
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
  // recovers under an auto-restart supervisor. Exit is deferred so the response
  // flushes first.
  restart: adminProcedure.mutation(() => {
    setTimeout(() => process.exit(0), 100);
    return { restarting: true as const };
  }),
});
