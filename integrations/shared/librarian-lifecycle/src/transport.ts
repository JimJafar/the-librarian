// Transport selection: local CLI vs remote HTTP MCP.
//
// The lifecycle's `LibrarianCli` is the same synchronous interface either way.
// When `LIBRARIAN_MCP_URL` is set the harness talks to a REMOTE Librarian (the
// marketplace plugin's deployment — see remote-cli.ts); otherwise it spawns the
// local `the-librarian` CLI against a local store. The orchestration is
// transport-agnostic, so every adapter selects here and is otherwise unchanged.

import { type LibrarianCli, createLibrarianCli } from "./cli.js";
import { createRemoteLibrarianCli } from "./remote-cli.js";
import type { Harness } from "./state.js";

/** Remote transport is chosen when an MCP endpoint is configured. */
export function shouldUseRemote(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.LIBRARIAN_MCP_URL && env.LIBRARIAN_MCP_URL.trim());
}

export interface TransportOptions {
  harness: Harness;
  /** Agent id for local-CLI attribution (remote attribution is token-bound). */
  agent: string;
  /** Working directory — the cwd match key (§5.2) and the continue attach target. */
  cwd?: string;
  sourceRef?: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Build the `LibrarianCli` for the current environment: the remote HTTP transport
 * when `LIBRARIAN_MCP_URL` is set, else the local `the-librarian` CLI. The remote
 * transport reads the endpoint + token from `env`; a missing token surfaces as a
 * clean fail-soft error from the helper, not here.
 */
export function createLibrarianCliForEnv(options: TransportOptions): LibrarianCli {
  if (shouldUseRemote(options.env)) {
    const config: Parameters<typeof createRemoteLibrarianCli>[0] = {
      harness: options.harness,
      env: options.env,
    };
    if (options.cwd !== undefined) config.cwd = options.cwd;
    if (options.sourceRef !== undefined) config.sourceRef = options.sourceRef;
    return createRemoteLibrarianCli(config);
  }
  return createLibrarianCli({
    agent: options.agent,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
}
