// Server auto-update admin tRPC procedures (spec 2026-06-16-server-autoupdate T2).
//
// The dashboard (and the CLI `server autoupdate` command, and the host wrapper's
// `--run`) read/write the auto-update settings through this router. It decouples
// *what's configured* (these settings, editable anywhere) from *who acts* (the
// host timer that performs the update) — the dashboard never holds host/docker
// privileges, it only writes a setting (spec §2).
//
// `get` returns the configured state (enabled, cadence, lastRunAt) plus the
// running build's version + the latest published release (reusing health's
// `getLatestRelease`) so the dashboard can render an "update available?" line
// next to the toggle. `set` patches the enablement flag and/or the cadence,
// validating the cadence ∈ {daily, weekly} via the core helper (the single source
// of truth). All admin-gated — served only on the trusted internal listener
// (ADR 0008 P3); there is deliberately no consumer-agent surface for it.

import type { LibrarianStore } from "@librarian/core";
import {
  isAutoUpdateEnabled,
  readAutoUpdateCadence,
  readLastAutoUpdateAt,
  setAutoUpdateCadence,
  setAutoUpdateEnabled,
  writeLastAutoUpdateAt,
} from "@librarian/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getLatestRelease } from "../github-release.js";
import { PACKAGE_VERSION } from "../version.js";
import { adminProcedure, router } from "./trpc.js";

/**
 * The auto-update configured state in one read: the enablement flag, the cadence
 * (default daily), and the last-run timestamp (ISO string, or null when never
 * run). All plain settings — no master key needed. The dashboard pairs this with
 * `version`/`latest` (added in the `get` query) for the status line.
 */
function gatherAutoUpdateConfig(store: LibrarianStore) {
  const lastRunAt = readLastAutoUpdateAt(store);
  return {
    enabled: isAutoUpdateEnabled(store),
    cadence: readAutoUpdateCadence(store),
    lastRunAt: lastRunAt ? lastRunAt.toISOString() : null,
  };
}

export const autoupdateRouter = router({
  // The configured auto-update state + the version/latest the dashboard renders an
  // "update available?" line from (reusing health's cached GitHub-release lookup).
  // The latest-release lookup degrades gracefully (never throws) so a get always
  // resolves even offline.
  get: adminProcedure.query(async ({ ctx }) => ({
    ...gatherAutoUpdateConfig(ctx.store),
    version: PACKAGE_VERSION,
    latest: await getLatestRelease(),
  })),

  // Patch the auto-update config: the enablement toggle and/or the cadence. Both
  // fields are optional so the dashboard can patch one without the other. The
  // cadence validation defers to the core `setAutoUpdateCadence` (the single
  // source of truth: daily|weekly); its teaching error is surfaced as a BAD_REQUEST
  // tRPC error rather than a 500. Returns the fresh readable config.
  set: adminProcedure
    .input(
      z.strictObject({
        enabled: z.boolean().optional(),
        cadence: z.string().optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      if (input.cadence !== undefined) {
        try {
          setAutoUpdateCadence(ctx.store, input.cadence);
        } catch (error) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: error instanceof Error ? error.message : String(error),
            cause: error,
          });
        }
      }
      if (input.enabled !== undefined) setAutoUpdateEnabled(ctx.store, input.enabled);
      return gatherAutoUpdateConfig(ctx.store);
    }),

  // Stamp `last_run_at` to NOW. Called by the host `--run` wrapper ONLY after a
  // SUCCESSFUL `server update`, so the next due-check advances by one cadence
  // window. Kept distinct from `set` (which the dashboard owns) so a dashboard
  // toggle never accidentally moves the last-run clock. Admin-gated / internal
  // listener only, like every procedure here. Returns the fresh readable config.
  stampRun: adminProcedure.mutation(({ ctx }) => {
    writeLastAutoUpdateAt(ctx.store, new Date());
    return gatherAutoUpdateConfig(ctx.store);
  }),
});
