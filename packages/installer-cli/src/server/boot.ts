// `librarian server enable-boot` / `disable-boot` — Linux systemd boot
// persistence for the all-in-one container. (macOS launchd is deferred — §9.)
//
// SECURITY — the whole point of this slice. The systemd unit MUST NOT contain
// any secret. We do NOT bake a `docker run -e LIBRARIAN_AGENT_TOKEN=…` into
// `ExecStart`: that would write the agent token into a world-readable
// `/etc/systemd/system/*.service` file — a leak. Instead the unit references the
// EXISTING named container (created by `up`/`update`, whose env — including the
// token — lives in Docker's own container state, not a file we manage):
//
//   ExecStart=/usr/bin/docker start --attach the-librarian
//   ExecStop=/usr/bin/docker stop the-librarian
//
// `docker start --attach` re-uses the container exactly as `up` created it
// (same name, same env, same volume) and stays in the foreground so systemd's
// `Type=simple` supervision + `Restart=always` work. This survives a `server
// update` (which recreates the SAME container name) and reboots, with NO secret
// anywhere on disk that we write.
//
// We default to a SYSTEM unit (`/etc/systemd/system/…`, via `sudo`) because it
// boots reliably without a login session. (A `--user` unit under
// `~/.config/systemd/user/` would need `loginctl enable-linger` to survive
// logout — out of scope for v1; deliberately not built.)
//
// Writing to `/etc/systemd/system` needs root, so the unit is written to a
// temp file first (NON-SECRET content) and then `sudo cp`'d into place — every
// privileged step (`sudo cp`/`chmod`/`rm`, `sudo systemctl …`) routes through
// the injectable `docker.ts` runner so tests assert the exact argv and never
// touch real systemd, sudo, or docker.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { run, which } from "./docker.js";
import { CONTAINER_NAME } from "./up.js";

/** The systemd unit file name (single instance per host). */
export const UNIT_NAME = "the-librarian.service";

/** The system-unit directory (a system unit boots without a login session). */
const SYSTEMD_SYSTEM_DIR = "/etc/systemd/system";

/** The absolute path the unit is installed at (the system unit, via sudo). */
export function unitPath(): string {
  return path.join(SYSTEMD_SYSTEM_DIR, UNIT_NAME);
}

/** Fallback docker path if `which docker` can't be resolved (well-known location). */
const DEFAULT_DOCKER_PATH = "/usr/bin/docker";

export interface BootOptions {
  /** Platform — gates the macOS deferral. Default `process.platform`. */
  platform?: NodeJS.Platform | undefined;
}

/** A teaching error from boot ops; the runtime renders `.message` as one stderr line. */
export class BootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootError";
  }
}

export interface BootResult {
  /** Human-readable report for stdout. */
  output: string;
}

/** Inputs to the pure unit generator (only a docker path — NEVER a secret). */
export interface UnitInput {
  /** The absolute path to the `docker` binary used in ExecStart/ExecStop. */
  dockerPath: string;
}

/**
 * Generate the systemd unit text. PURE + unit-tested. The headline invariant:
 * it contains NO secret — no agent token, no `LIBRARIAN_AGENT_TOKEN`, no
 * `docker run` / `-e` env injection — only a `docker start --attach` /
 * `docker stop` of the EXISTING named container. The container already carries
 * its env (incl. the token) in Docker's own state, so referencing it by name
 * needs no secret in this file.
 */
export function generateUnit(input: UnitInput): string {
  const { dockerPath } = input;
  return [
    "[Unit]",
    "Description=The Librarian (all-in-one)",
    "After=docker.service",
    "Requires=docker.service",
    "",
    "[Service]",
    "Type=simple",
    // Reference the EXISTING named container — NO `docker run`, NO `-e <secret>`.
    // `--attach` keeps it in the foreground so Type=simple supervision works.
    `ExecStart=${dockerPath} start --attach ${CONTAINER_NAME}`,
    `ExecStop=${dockerPath} stop ${CONTAINER_NAME}`,
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

/** The one-line macOS-deferred notice (shared by enable/disable + `up`). */
export const MACOS_NOTICE =
  "Boot persistence is Linux-only for now (launchd support is deferred). " +
  "Skipping — on macOS, start the server manually with `librarian server up`, " +
  "or use Docker Desktop's 'start on login' for the container.";

/** True iff boot persistence is unsupported on this platform (macOS for now). */
function isUnsupportedPlatform(platform: NodeJS.Platform): boolean {
  return platform === "darwin";
}

/**
 * Boot-specific preflight: `docker` must be on PATH (the unit runs `docker
 * start` at boot). Unlike the container-op preflight this does NOT require git
 * or a reachable daemon — enabling/disabling a unit file needs neither. A
 * missing docker is a teaching `BootError`.
 */
async function requireDocker(): Promise<void> {
  if ((await which("docker")) === null) {
    throw new BootError(
      "Docker is required but was not found on your PATH. " +
        "The boot unit runs `docker start` — install Docker Engine (Linux) " +
        "— see https://docs.docker.com/get-docker/ — then re-run this command.",
    );
  }
}

/**
 * Resolve the absolute `docker` path for the unit's ExecStart. Goes through the
 * injectable runner (`which docker`); falls back to the well-known
 * `/usr/bin/docker` so a non-standard `which` output never breaks unit
 * generation. The path is non-secret, so a fallback is safe.
 */
async function resolveDockerPath(): Promise<string> {
  const resolved = await which("docker");
  return resolved && resolved.trim().length > 0 ? resolved.trim() : DEFAULT_DOCKER_PATH;
}

/**
 * Enable boot persistence. On Linux: write the unit to `/etc/systemd/system`
 * (root, so temp-file + `sudo cp` + `sudo chmod 644`), `sudo systemctl
 * daemon-reload`, then `sudo systemctl enable --now the-librarian.service`.
 * Idempotent — re-running rewrites the SAME unit path and re-enables, never
 * duplicating. On macOS: print the deferred notice and skip cleanly (NOT an
 * error).
 */
export async function enableBoot(options: BootOptions = {}): Promise<BootResult> {
  const platform = options.platform ?? process.platform;
  if (isUnsupportedPlatform(platform)) {
    return { output: MACOS_NOTICE };
  }

  // Boot persistence runs `docker start` at boot, so it needs `docker` on PATH
  // — but NOT git (no clone here) and NOT a reachable daemon right now (the unit
  // fires at boot, not at enable time). A lighter, boot-specific preflight.
  await requireDocker();

  const dockerPath = await resolveDockerPath();
  const unit = generateUnit({ dockerPath });
  await installUnit(unit);

  // daemon-reload BEFORE enable --now so systemd sees the (possibly rewritten)
  // unit. enable --now both enables-on-boot and starts the container now.
  await sudoSystemctl(["daemon-reload"]);
  await sudoSystemctl(["enable", "--now", UNIT_NAME]);

  return {
    output: [
      `Boot persistence enabled — ${UNIT_NAME} will start the container on boot.`,
      `  Unit: ${unitPath()} (references the existing '${CONTAINER_NAME}' container; no secret in the file)`,
      "Disable it again with `librarian server disable-boot`.",
    ].join("\n"),
  };
}

/**
 * Disable boot persistence. On Linux: `sudo systemctl disable --now
 * the-librarian.service`, remove the unit file (`sudo rm -f`), then `sudo
 * systemctl daemon-reload`. Safe if already disabled/absent — a non-zero
 * `disable` (unit not loaded) becomes a friendly teaching message, never a
 * crash; the `rm -f` + reload still run so a stale unit file is cleaned up. On
 * macOS: print the deferred notice and skip cleanly.
 */
export async function disableBoot(options: BootOptions = {}): Promise<BootResult> {
  const platform = options.platform ?? process.platform;
  if (isUnsupportedPlatform(platform)) {
    return { output: MACOS_NOTICE };
  }

  await requireDocker();

  // disable --now: tolerate "unit does not exist / not loaded" — already off.
  const disable = await run("sudo", ["systemctl", "disable", "--now", UNIT_NAME]);
  const alreadyAbsent = disable.code !== 0 && isUnitAbsent(disable.stderr);
  if (disable.code !== 0 && !alreadyAbsent) {
    failIfNonZero("sudo", ["systemctl", "disable", "--now", UNIT_NAME], disable);
  }

  // Remove the unit file (idempotent with `-f`), then daemon-reload so systemd
  // forgets it. `rm -f` never errors on an absent file.
  await sudoRun(["rm", "-f", unitPath()]);
  await sudoSystemctl(["daemon-reload"]);

  return {
    output: alreadyAbsent
      ? [
          `Boot persistence was not enabled (${UNIT_NAME} was not loaded) — nothing to disable.`,
          `Removed any stale unit file at ${unitPath()} and reloaded systemd.`,
        ].join("\n")
      : [
          `Boot persistence disabled — ${UNIT_NAME} removed and systemd reloaded.`,
          "The container itself is untouched; stop it with `librarian server down`.",
        ].join("\n"),
  };
}

// --- privileged steps (every one through the injectable runner) ----------

/**
 * Write the unit to the system path. `/etc/systemd/system` needs root, so the
 * NON-SECRET unit text is written to a temp file first, then `sudo cp`'d into
 * place and `sudo chmod 644`'d (world-readable is fine — there is no secret in
 * it, by construction). The temp file is removed afterward. The `cp`/`chmod`
 * argv is asserted by tests; the temp source carries the unit content for the
 * test's no-secret check (the fake runner doesn't really move it).
 */
async function installUnit(unit: string): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "librarian-unit-"));
  const tmp = path.join(dir, UNIT_NAME);
  writeFileSync(tmp, unit, "utf8");
  try {
    await sudoRun(["cp", tmp, unitPath()]);
    await sudoRun(["chmod", "644", unitPath()]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run `sudo systemctl <args…>`; a non-zero exit is a teaching error. */
async function sudoSystemctl(args: string[]): Promise<void> {
  await sudoRun(["systemctl", ...args]);
}

/** Run `sudo <args…>`; a non-zero exit is a teaching error. */
async function sudoRun(args: string[]): Promise<void> {
  const result = await run("sudo", args);
  failIfNonZero("sudo", args, result);
}

/** True when a `systemctl disable` failure means the unit simply isn't loaded. */
function isUnitAbsent(stderr: string): boolean {
  return /does not exist|not loaded|no such file|not found/i.test(stderr);
}

function failIfNonZero(
  cmd: string,
  args: string[],
  result: { code: number | null; stderr: string; stdout: string },
): void {
  if (result.code === 0) return;
  const detail = result.stderr.trim() || result.stdout.trim();
  throw new BootError(
    `\`${cmd} ${args[0]}\` failed (exit ${result.code ?? "signal"})` +
      (detail ? `:\n${detail}` : ".") +
      "\n\nResolve the error above (you may need sudo privileges), then re-run the command.",
  );
}
