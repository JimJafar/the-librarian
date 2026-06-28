// Ingest-log admin tRPC procedures (reference-ingest spec criterion 15 / D7).
//
// Read-only aggregation over the C1 ingest decision log (core's ingest-log.ts,
// stored in the settings sidecar — there is no relational DB here). The dashboard
// "Captures" panel reads `recent` to show every capture attempt and `failures`
// to surface the ones that need attention, so the operator can revisit a URL and
// capture it manually (D7).
//
// All admin-gated — there is deliberately NO consumer-agent surface for the
// ingest log; the capture clients WRITE the log over the /ingest HTTP endpoint,
// never read it. The rows core returns are already redacted (D25): `source` and
// `error` never carry a `user:pass@host` URL or an upstream-auth header in
// plaintext, so this router exposes them as-is.

import { type IngestLogRecord, listFailures, listRecent } from "@librarian/core";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

// The dashboard pages a bounded, newest-first window. Default 50, clamped to a
// sane ceiling so a giant log can't blow the response up; core also floors a
// negative limit at 0.
const RecentInput = z.strictObject({
  limit: z.number().int().positive().max(200).optional(),
});

const DEFAULT_LIMIT = 50;

export const ingestRouter = router({
  // Most-recent capture attempts, newest-first (pending | success | failed).
  recent: adminProcedure
    .input(RecentInput.optional())
    .query(({ ctx, input }): IngestLogRecord[] =>
      listRecent(ctx.store, input?.limit ?? DEFAULT_LIMIT),
    ),

  // The "needs attention" list: every failed attempt, newest-first (D7).
  failures: adminProcedure.query(({ ctx }): IngestLogRecord[] => listFailures(ctx.store)),
});
