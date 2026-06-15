// Backup admin tRPC procedures: trigger a git-push backup of the vault, read
// recent run health, and read/update the schedule + GitHub remote. All
// admin-gated. Config reads never return the token — only whether it's set.

import type { BackupConfigPatch } from "@librarian/core";
import {
  githubRepoSlugError,
  isValidGithubRepoSlug,
  lastSuccessfulBackupRun,
  latestTerminalBackupRun,
  listBackupRuns,
  readBackupConfig,
  resolveBackupRemote,
  runBackup,
  stageRestore,
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
      // The repo is interpolated into the push remote URL as `…/<repo>.git`, so it
      // must be a bare "owner/repo" slug. An empty string is allowed (it leaves the
      // stored value untouched); a non-empty value must match the slug shape, with a
      // teaching error that echoes the bad value (never a token).
      repo: z
        .string()
        .optional()
        .refine((repo) => repo === undefined || repo === "" || isValidGithubRepoSlug(repo), {
          // The message echoes the offending value so the reader sees their typo; the
          // value here is always the repo slug — never a token.
          error: (issue) => githubRepoSlugError(typeof issue.input === "string" ? issue.input : ""),
        }),
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
      // Whether a restore CAN run: a backup remote is resolvable (repo + a
      // decryptable token, or the env fallback). This — NOT "has a prior
      // successful local run" — is what gates the dashboard Restore button, so a
      // fresh deployment restoring from an existing remote (e.g. a host migration)
      // can stage a restore.
      canRestore: resolveBackupRemote(ctx.store) !== null,
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

  // Stage a restore: clone the backup remote into a staging dir and write the
  // pending-restore marker. It is APPLIED on the next boot — never under the live
  // store (the vault dir is swapped while nothing holds it). The cockpit then
  // prompts a restart.
  stageRestore: adminProcedure.mutation(({ ctx }) => stageRestore(ctx.store)),

  // Exit the server so the supervisor/orchestrator restarts it (applying any staged
  // restore on boot). The cockpit's "Restart now" button warns that this only
  // recovers under an auto-restart supervisor. Sends SIGTERM (not a raw exit) so the
  // bin's graceful shutdown runs — schedulers stop + `store.close()` — before the
  // process leaves, so the next boot applies the restore on a quiesced vault. The
  // signal is deferred so the { restarting: true } ack flushes first.
  restart: adminProcedure.mutation(() => {
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 250);
    return { restarting: true as const };
  }),
});
