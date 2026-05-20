import { callerAgent, flagString } from "../parse-flags.js";
import type { Command } from "./_shared.js";

export const continueCommand: Command = (store, positionals, flags) => {
  const sessionId = positionals[0];
  if (!sessionId) {
    return { stdout: "Usage: the-librarian sessions continue <session_id>", exitCode: 1 };
  }
  const attach = flags.attach !== false;
  const result = store.continueSession({
    agent_id: callerAgent(flags),
    admin: flags.admin === true,
    session_id: sessionId,
    target_harness: flagString(flags["target-harness"]),
    target_source_ref: flagString(flags["target-source-ref"]),
    target_cwd: flagString(flags["target-cwd"]),
    attach,
    format: flagString(flags.format),
  });
  if (flags.json) return { stdout: JSON.stringify(result, null, 2), exitCode: 0 };
  return { stdout: result.text, exitCode: 0 };
};
