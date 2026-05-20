// Health router.
//
// `health.ping` is a typed-client smoke-test procedure. It is public
// (no admin gate) so a dashboard or external probe can verify the
// tRPC mount is alive before configuring credentials.

import { publicProcedure, router } from "./trpc.js";

export const healthRouter = router({
  ping: publicProcedure.query(() => ({ ok: true as const })),
});
