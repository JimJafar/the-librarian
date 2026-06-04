// Backup admin tRPC procedures: trigger a git-push backup of the vault, read
// recent run health, and read/update the schedule + GitHub remote. All
// admin-gated. Config reads never return the token — only whether it's set.

import type { BackupConfigPatch } from "@librarian/core";
import {
  lastSuccessfulBackupRun,
  latestTerminalBackupRun,
  listBackupRuns,
  readBackupConfig,
  runBackup,
  writeBackupConfig,
} from "@librarian/core";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

const LIST_LIMIT = 10;

const SetConfigSchema = z.strictObject({
  enabled: z.boolean().optional(),
  intervalMinutes: z.number().int().min(1).optional(),
  webhookUrl: z.string().optional(),
  // The GitHub backup remote. The token is a secret, write-only — an empty/absent
  // value leaves the stored token unchanged (the form never round-trips it).
  github: z
    .strictObject({
      repo: z.string().optional(),
      token: z.string().optional(),
    })
    .optional(),
});

export const backupRouter = router({
  // Push the vault to the configured remote now (manual trigger).
  createNow: adminProcedure.mutation(async ({ ctx }) => {
    const result = await runBackup(ctx.store, { trigger: "manual" });
    return { pushed: result.pushed, commit: result.commit, repo: result.repo };
  }),

  // Recent backup run health (status, target repo, error, timestamps).
  runs: adminProcedure
    .input(z.strictObject({ limit: z.number().int().positive().max(100).optional() }).optional())
    .query(({ ctx, input }) => listBackupRuns(ctx.store, input?.limit ?? LIST_LIMIT)),

  // Non-secret config view + health summary. Never returns the token value.
  config: adminProcedure.query(({ ctx }) => {
    const cfg = readBackupConfig(ctx.store);
    const settingKeys = new Set(ctx.store.listSettings().map((s) => s.key));
    return {
      enabled: cfg.enabled,
      intervalMinutes: cfg.intervalMinutes,
      webhookUrl: cfg.webhookUrl,
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
    if (input.webhookUrl !== undefined) patch.webhookUrl = input.webhookUrl;
    writeBackupConfig(ctx.store, patch);

    if (input.github) {
      if (input.github.repo !== undefined) {
        ctx.store.setSetting("backup.github.repo", input.github.repo);
      }
      if (input.github.token) {
        ctx.store.setSetting("backup.github.token", input.github.token, { secret: true });
      }
    }

    return { ok: true };
  }),
});
