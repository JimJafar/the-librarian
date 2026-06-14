// `librarian server admin <verb> [args…]` — run a curated subset of the
// folded-in admin CLI (`@librarian/cli`, the `the-librarian` binary) INSIDE the
// running all-in-one container. Spec §7 ("Folded-in admin").
//
// One uniform mechanism: `docker exec the-librarian the-librarian <verb> [args…]`.
// Running it in the container (not on the host) gives the admin CLI direct
// access to the data dir + the store/settings the server already uses — which is
// exactly what lets `auth` recovery bypass a locked dashboard and lets
// `backup`/`restore` reuse the store rather than re-implement it. (The CLI is
// bundled into the runtime image in the same slice — see all-in-one.Dockerfile.)
//
// CURATED set (spec §7): only `backup | restore | auth | rebuild` are exposed.
// `seed` / `migrate-data-dir` / `export` / `handoffs` exist in @librarian/cli but
// are deliberately NOT folded in here (seed is dev-only; migrate-data-dir runs
// automatically on `update`; export + handoffs are power-user/dashboard surfaces).
// They stay reachable via a raw `docker exec` if ever truly needed.
//
// Args after the verb are passed through VERBATIM, in order — this module never
// parses, reorders, or rewrites them (so e.g. `auth reset-password --user x` and
// `restore --secret-key …` reach the CLI exactly as typed). A bearer/secret may
// ride through as an arg the CLI itself reads; this module never logs or persists
// it (AGENTS.md: privacy beats convenience).
//
// Everything goes through the injectable `docker.ts` seam, so tests assert the
// exact argv without a real daemon or container.

import { run } from "./docker.js";
import { preflight } from "./preflight.js";
import { CONTAINER_NAME } from "./up.js";

/** The curated admin verbs exposed under `server admin` (spec §7). */
export const ADMIN_VERBS = ["backup", "restore", "auth", "rebuild"] as const;

export type AdminVerb = (typeof ADMIN_VERBS)[number];

/** A teaching error from `admin`; the runtime renders `.message` as one stderr line. */
export class AdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminError";
  }
}

export interface AdminOptions {
  /** Platform for preflight's daemon hint. Default `process.platform`. */
  platform?: NodeJS.Platform | undefined;
  /**
   * Whether the run is interactive (a TTY is attached). When true we add
   * `docker exec -it` so the in-container CLI can prompt (e.g. `restore`'s
   * `--secret-key` prompt, `auth reset-password`). A non-interactive run omits
   * `-it` so it works in scripts/CI without a TTY.
   */
  interactive?: boolean | undefined;
}

export interface AdminResult {
  /** Human-readable report for stdout (the in-container CLI's own output). */
  output: string;
}

/** True iff `verb` is one of the curated admin verbs. */
function isAdminVerb(verb: string): verb is AdminVerb {
  return (ADMIN_VERBS as readonly string[]).includes(verb);
}

/** The teaching message for an unknown/dropped verb — names what IS available. */
function unknownVerbMessage(verb: string | undefined): string {
  const allowed = ADMIN_VERBS.join(" | ");
  const lead =
    verb === undefined
      ? "`librarian server admin` needs a subcommand."
      : `\`${verb}\` is not an \`admin\` subcommand.`;
  return [
    lead,
    "",
    `Allowed: ${allowed}.`,
    "",
    "Not exposed here (by design): `seed` (dev-only), `migrate-data-dir` (runs",
    "automatically on `librarian server update`), `export`, and `handoffs`",
    "(power-user / dashboard surfaces).",
  ].join("\n");
}

/**
 * Confirm the container is up before exec'ing into it. `docker inspect` reports
 * `running` when it is; any other status (or a failed inspect → absent) is a
 * teaching error pointing at `server up`, with NO `docker exec`.
 */
async function assertContainerRunning(): Promise<void> {
  const result = await run("docker", ["inspect", "--format", "{{.State.Status}}", CONTAINER_NAME]);
  const status = result.code === 0 ? result.stdout.trim() : null;
  if (status !== "running") {
    throw new AdminError(
      "The server isn't running — run `librarian server up` first, then re-run " +
        "this admin command.",
    );
  }
}

/**
 * Run `server admin <verb> [args…]`. Validates the verb is curated, preflights
 * docker, confirms the container is running, then runs
 * `docker exec [-it] the-librarian the-librarian <verb> [args…]` — passing the
 * args through VERBATIM. A rejected verb / down container is a teaching
 * `AdminError`; no `docker exec` runs in either case.
 */
export async function runAdmin(
  argv: readonly string[],
  options: AdminOptions = {},
): Promise<AdminResult> {
  const [verb, ...rest] = argv;

  // Validate FIRST — a rejected verb must never reach a `docker exec` (and we
  // don't even need a daemon to tell the user the verb is wrong).
  if (verb === undefined || !isAdminVerb(verb)) {
    throw new AdminError(unknownVerbMessage(verb));
  }

  await preflight(options.platform ? { platform: options.platform } : {});
  await assertContainerRunning();

  // `docker exec [-it] the-librarian the-librarian <verb> [args…]` — args verbatim.
  const execArgs = [
    "exec",
    ...(options.interactive ? ["-it"] : []),
    CONTAINER_NAME,
    "the-librarian",
    verb,
    ...rest,
  ];
  const result = await run("docker", execArgs);

  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new AdminError(
      `\`the-librarian ${verb}\` failed in the container (exit ${result.code ?? "signal"})` +
        (detail ? `:\n${detail}` : ".") +
        `\n\nResolve the error above, then re-run \`librarian server admin ${verb}\`.`,
    );
  }

  // The in-container CLI's own output is the report (stdout, then any stderr).
  return { output: result.stdout + result.stderr };
}
