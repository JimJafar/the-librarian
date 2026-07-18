import {
  type BootstrapClaimHandle,
  createBootstrapClaimHandle,
  createInertBootstrapClaimHandle,
} from "@librarian/core";

const CLAIM_SECRET_ENV = "LIBRARIAN_BOOTSTRAP_CLAIM_SECRET";

/**
 * Resolve the one process-wide bootstrap-claim handle at the env boundary. An
 * absent variable is genuinely inert; a present weak value is a boot error.
 */
export function resolveBootstrapClaimHandle(
  env: NodeJS.ProcessEnv,
  dataDir: string,
): BootstrapClaimHandle {
  const secret = env[CLAIM_SECRET_ENV];
  if (secret === undefined) return createInertBootstrapClaimHandle();
  return createBootstrapClaimHandle({ dataDir, secret });
}
