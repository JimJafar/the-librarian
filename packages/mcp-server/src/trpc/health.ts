// Health router.
//
// `health.ping` is a typed-client smoke-test procedure. It is public
// (no admin gate) so a dashboard or external probe can verify the
// tRPC mount is alive before configuring credentials.
//
// `health.info` exposes the running build's version + the latest
// published GitHub release so the dashboard can render a "behind
// latest" indicator. Also public — no secrets in the payload, and the
// dashboard renders the badge in pre-auth chrome too.

import { getLatestRelease } from "../github-release.js";
import { PACKAGE_VERSION } from "../version.js";
import { publicProcedure, router } from "./trpc.js";

export const healthRouter = router({
  ping: publicProcedure.query(() => ({ ok: true as const })),

  info: publicProcedure.query(async () => {
    const latest = await getLatestRelease();
    return {
      version: PACKAGE_VERSION,
      latest,
    };
  }),
});
