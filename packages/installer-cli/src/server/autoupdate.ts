// `librarian server autoupdate <enable|disable|uninstall|status|--run>` — the
// HOST half of the server auto-update feature (spec 2026-06-16-server-autoupdate
// T3). The server settings + admin tRPC are T1/T2; this is the scheduler that
// actually performs the update on the host.
//
// THE ARCHITECTURAL CONSTRAINT (spec §2). `server update` is host-level: it
// rebuilds the image and `docker rm`s + recreates the container. A process INSIDE
// the container cannot recreate its own container (no docker-socket access, by
// design). So the act of updating MUST run on the host. This module installs a
// host scheduler (a systemd timer; a cron fallback where systemd is absent) that
// fires frequently (~hourly) and runs `librarian server autoupdate --run`. The
// wrapper reads the auto-update settings from the RUNNING server, applies the
// due-check, and conditionally calls `server update`. The dashboard/CLI only
// WRITE the settings (enabled, cadence) — never the host action.
//
// HOW `--run` READS THE SETTINGS (decision). The settings live in the server's
// data volume, and the admin tRPC that reads them is served only on the INTERNAL
// listener (127.0.0.1:3840 inside the container — ADR 0008 P1/P3, no bearer
// gate), which is NOT published to the host. A named docker volume is not a clean
// host path either. So the wrapper reaches the settings the SAME way `server
// admin` reaches in-container state: `docker exec the-librarian node -e <script>`,
// where the script does a localhost `fetch` of the internal tRPC `autoupdate.get`
// / `autoupdate.set` from inside the container. This is the cleanest mechanism —
// it reuses the existing exec seam, needs no published port, and honours ADR
// 0008's "the socket is the gate" model (the internal listener trusts loopback).
//
// FAIL-SOFT (AGENTS.md + spec §3 SC4/SC7). The `--run` wrapper NEVER throws out of
// the timer: any failure (server unreachable, a non-zero update) is logged on one
// line and the wrapper exits 0. Server unreachable → SKIP (conservative: never
// auto-update a server in an unknown state). A successful update stamps
// `last_run_at`; a FAILED update does NOT stamp it (so the next fire retries) and
// relies on `server update`'s own health-check rollback to leave the prior
// container running.
//
// Everything privileged routes through the injectable `docker.ts` runner (the
// same seam boot.ts uses), so tests assert the exact systemctl/crontab/docker
// argv without a real systemd, cron, or docker.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AUTOUPDATE_CADENCES,
  type AutoUpdateCadence,
  DEFAULT_AUTOUPDATE_CADENCE,
  isAutoUpdateCadence,
} from "@librarian/core";
import { run, which } from "./docker.js";
import { redactSecrets } from "./redact.js";
import { serverStatus } from "./status.js";
import { CONTAINER_NAME } from "./up.js";
import { runUpdate, UpdateError } from "./update.js";

/** The oneshot service unit that runs the `--run` wrapper (single instance per host). */
export const AUTOUPDATE_SERVICE_NAME = "the-librarian-autoupdate.service";

/** The timer unit that fires the oneshot service ~hourly. */
export const AUTOUPDATE_TIMER_NAME = "the-librarian-autoupdate.timer";

/** The system-unit directory (a system timer fires without a login session). */
const SYSTEMD_SYSTEM_DIR = "/etc/systemd/system";

/** A stable marker that tags OUR crontab line, so we can find/replace/remove it idempotently. */
export const CRON_MARKER = "# the-librarian-autoupdate";

/** Fallback `librarian` path if `which librarian` can't be resolved (npm global bin). */
const DEFAULT_LIBRARIAN_PATH = "/usr/local/bin/librarian";

/** The internal tRPC listener inside the container (ADR 0008 P1 default). */
const INTERNAL_TRPC_URL = "http://127.0.0.1:3840/trpc";

/** The absolute path the oneshot service is installed at (system unit, via sudo). */
export function servicePath(): string {
  return path.join(SYSTEMD_SYSTEM_DIR, AUTOUPDATE_SERVICE_NAME);
}

/** The absolute path the timer is installed at (system unit, via sudo). */
export function timerPath(): string {
  return path.join(SYSTEMD_SYSTEM_DIR, AUTOUPDATE_TIMER_NAME);
}

/** A teaching error from autoupdate ops; the runtime renders `.message` as one stderr line. */
export class AutoUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoUpdateError";
  }
}

export interface AutoUpdateResult {
  /** Human-readable report for stdout. */
  output: string;
}

export interface AutoUpdateOptions {
  /** Platform — gates the macOS deferral + systemd-vs-cron choice. Default `process.platform`. */
  platform?: NodeJS.Platform | undefined;
  /** Override home (tests). Threads into `server update`/`status`. */
  home?: string | undefined;
  /** Deploy dir override. Default: `~/.librarian/server`. Threads into update/status. */
  dir?: string | undefined;
}

export interface EnableOptions extends AutoUpdateOptions {
  /** Cadence to write into the running server. Default daily. Validated daily|weekly. */
  cadence?: string | undefined;
}

export interface RunOptions extends AutoUpdateOptions {
  /**
   * Sink for the wrapper's one-line log entries (the timer's journal). Defaults
   * to a `process.stderr` writer; tests inject a recorder. Every wrapper outcome
   * (skip / update / failure) emits exactly one line here — and the wrapper never
   * throws, so the timer's unit always exits 0.
   */
  log?: ((line: string) => void) | undefined;
  /** Health-wait bound for the inner `server update` (small in tests). */
  healthAttempts?: number | undefined;
  /** Milliseconds between health polls for the inner update (0 in tests). */
  healthIntervalMs?: number | undefined;
  /** Injected current time for the due-check (tests). Default `new Date()`. */
  now?: Date | undefined;
}

// --- pure unit generators (unit-tested directly) -------------------------

/** Inputs to the pure service generator (only the librarian path — NEVER a secret). */
export interface ServiceUnitInput {
  /** Absolute path to the `librarian` binary the oneshot runs with `server autoupdate --run`. */
  librarianPath: string;
}

/**
 * Generate the oneshot service unit text. PURE + unit-tested. Contains NO secret —
 * it runs `librarian server autoupdate --run`, which reads the settings from the
 * running container itself (via `docker exec`), so nothing sensitive is written
 * into this world-readable unit file. `Type=oneshot` because the wrapper runs to
 * completion each fire (it is the timer's job to schedule, not the service's).
 */
export function generateServiceUnit(input: ServiceUnitInput): string {
  const { librarianPath } = input;
  return [
    "[Unit]",
    "Description=The Librarian — auto-update check (host-scheduled)",
    "After=docker.service",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=oneshot",
    // The wrapper reads the auto-update settings from the running container and,
    // if due, performs `server update`. It carries NO secret on this argv: the
    // settings + the container's credentials live in the container, reached via
    // `docker exec` at run time, not baked into this file.
    `ExecStart=${librarianPath} server autoupdate --run`,
    "",
  ].join("\n");
}

/**
 * Generate the timer unit text. PURE + unit-tested. Fires the oneshot service
 * roughly hourly (`OnCalendar=hourly`, with `Persistent=true` so a missed fire
 * while the host was off runs at next boot). The FREQUENT fire is deliberate: the
 * cadence (daily/weekly) is a due-check IN the wrapper, NOT the timer period — so
 * the dashboard can change cadence (a setting) with no host action (spec §4). A
 * randomized delay spreads load and avoids every host updating on the exact hour.
 */
export function generateTimerUnit(): string {
  return [
    "[Unit]",
    "Description=The Librarian — auto-update timer (fires the check hourly)",
    "",
    "[Timer]",
    // Hourly poll; the cadence due-check inside the wrapper decides whether to act.
    "OnCalendar=hourly",
    // Run a missed fire (host was off) on next boot rather than skipping the window.
    "Persistent=true",
    // Spread load: fire up to 5 min after the hour rather than exactly on it.
    "RandomizedDelaySec=300",
    `Unit=${AUTOUPDATE_SERVICE_NAME}`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}

/**
 * The crontab line for the cron fallback (systemd absent). Fires the wrapper at
 * minute 17 of every hour (off the top-of-hour to spread load), tagged with
 * {@link CRON_MARKER} so it can be found/replaced/removed idempotently. NO secret
 * — same reasoning as the systemd unit (the wrapper reads settings from the
 * container at run time).
 */
export function cronLine(librarianPath: string): string {
  return `17 * * * * ${librarianPath} server autoupdate --run ${CRON_MARKER}`;
}

// --- librarian-path resolution -------------------------------------------

/**
 * Resolve the absolute `librarian` path the scheduler invokes. Goes through the
 * injectable runner (`which librarian`); falls back to the npm-global bin so a
 * non-standard `which` output never breaks unit/cron generation. The path is
 * non-secret, so a fallback is safe.
 */
async function resolveLibrarianPath(): Promise<string> {
  const resolved = await which("librarian");
  return resolved && resolved.trim().length > 0 ? resolved.trim() : DEFAULT_LIBRARIAN_PATH;
}

// --- platform helpers ----------------------------------------------------

/** The one-line macOS-deferred notice (boot persistence + autoupdate are Linux-only for now). */
export const MACOS_NOTICE =
  "Host auto-update scheduling is Linux-only for now (systemd timer / cron). " +
  "Skipping — on macOS, run `librarian server update` manually, or schedule it " +
  "yourself (e.g. a launchd agent / cron) to run `librarian server autoupdate --run`.";

/** True iff host scheduling is unsupported on this platform (macOS for now). */
function isUnsupportedPlatform(platform: NodeJS.Platform): boolean {
  return platform === "darwin";
}

/** True iff `systemctl` is on PATH (→ prefer the systemd timer over cron). */
async function hasSystemd(): Promise<boolean> {
  return (await which("systemctl")) !== null;
}

// --- the in-container settings bridge (docker exec node -e) ---------------

/**
 * A tiny Node script run INSIDE the container (`docker exec the-librarian node -e
 * <script>`) that talks to the internal tRPC listener over loopback. `op` is
 * `get` or `set`; for `set`, `input` is the JSON body. It prints the JSON result
 * to stdout (for `get`) or "ok" (for `set`), and exits non-zero on any failure so
 * the host wrapper can treat an unreachable/erroring server as a skip.
 *
 * Built as a single-line script with no string interpolation of untrusted data
 * (the cadence is validated daily|weekly before it reaches here; enabled is a
 * boolean), so there's no injection surface.
 */
function bridgeScript(
  op: "get" | "set" | "stampRun",
  input?: { enabled?: boolean; cadence?: AutoUpdateCadence },
): string {
  const base = `${INTERNAL_TRPC_URL}/autoupdate.${op}`;
  if (op === "get") {
    return (
      `fetch(${JSON.stringify(base)})` +
      `.then(r=>r.json())` +
      `.then(j=>{if(j.error){process.exit(3)}process.stdout.write(JSON.stringify(j.result.data))})` +
      `.catch(()=>process.exit(2))`
    );
  }
  // POST mutations (`set` carries a JSON body; `stampRun` takes no input).
  const bodyArg = op === "set" ? `,body:${JSON.stringify(JSON.stringify(input ?? {}))}` : "";
  return (
    `fetch(${JSON.stringify(base)},{method:"POST",headers:{"content-type":"application/json"}${bodyArg}})` +
    `.then(r=>r.json())` +
    `.then(j=>{if(j.error){process.exit(3)}process.stdout.write("ok")})` +
    `.catch(()=>process.exit(2))`
  );
}

/** The configured auto-update state read from the running server. */
export interface RunningConfig {
  enabled: boolean;
  cadence: AutoUpdateCadence;
  lastRunAt: string | null;
}

/**
 * Read the auto-update config from the RUNNING server via `docker exec node -e`
 * (the internal tRPC listener, loopback inside the container). Returns null when
 * the container is down / the exec fails / the response is unusable — the caller
 * treats null as "unreachable" and SKIPS (never auto-updates an unknown server).
 * Never throws.
 */
export async function readRunningConfig(): Promise<RunningConfig | null> {
  const result = await run("docker", ["exec", CONTAINER_NAME, "node", "-e", bridgeScript("get")]);
  if (result.code !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout.trim()) as {
      enabled?: unknown;
      cadence?: unknown;
      lastRunAt?: unknown;
    };
    const cadence =
      typeof parsed.cadence === "string" && isAutoUpdateCadence(parsed.cadence)
        ? parsed.cadence
        : DEFAULT_AUTOUPDATE_CADENCE;
    return {
      enabled: parsed.enabled === true,
      cadence,
      lastRunAt: typeof parsed.lastRunAt === "string" ? parsed.lastRunAt : null,
    };
  } catch {
    return null;
  }
}

/**
 * Write the auto-update config into the RUNNING server (so the dashboard reflects
 * the CLI's enable/cadence) via `docker exec node -e` → internal tRPC `set`.
 * Returns true on success, false when the container is down / the write failed.
 * Never throws — a write failure during `enable` is surfaced as a non-fatal hint
 * (the timer is still installed; the operator can toggle from the dashboard).
 */
export async function writeRunningConfig(input: {
  enabled?: boolean;
  cadence?: AutoUpdateCadence;
}): Promise<boolean> {
  const result = await run("docker", [
    "exec",
    CONTAINER_NAME,
    "node",
    "-e",
    bridgeScript("set", input),
  ]);
  return result.code === 0;
}

/**
 * Stamp `last_run_at` to NOW in the running server (the internal tRPC `stampRun`)
 * after a SUCCESSFUL auto-update, so the next due-check advances by one cadence
 * window. Returns true on success, false when the (freshly recreated) container
 * isn't reachable yet / the call failed — a failed stamp is non-fatal (the update
 * itself succeeded; the worst case is one extra due-check next fire). Never throws.
 */
export async function stampRunInServer(): Promise<boolean> {
  const result = await run("docker", [
    "exec",
    CONTAINER_NAME,
    "node",
    "-e",
    bridgeScript("stampRun"),
  ]);
  return result.code === 0;
}

// --- privileged systemd steps (every one through the injectable runner) ---

/** Write a unit file to the system path via temp-file + `sudo cp` + `sudo chmod 644`. */
async function installUnit(name: string, dest: string, unit: string): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "librarian-autoupdate-unit-"));
  const tmp = path.join(dir, name);
  writeFileSync(tmp, unit, "utf8");
  try {
    await sudoRun(["cp", tmp, dest]);
    await sudoRun(["chmod", "644", dest]);
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
  throw new AutoUpdateError(
    `\`${cmd} ${args[0]}\` failed (exit ${result.code ?? "signal"})` +
      (detail ? `:\n${detail}` : ".") +
      "\n\nResolve the error above (you may need sudo privileges), then re-run the command.",
  );
}

// --- enable --------------------------------------------------------------

/**
 * Install the host scheduler + write the enabled/cadence settings into the running
 * server. On Linux with systemd: write the oneshot service + the .timer to
 * `/etc/systemd/system`, `daemon-reload`, then `enable --now` the TIMER (the
 * service is oneshot — only the timer is enabled). Idempotent: re-running rewrites
 * the SAME unit paths and re-enables, never duplicating. Where systemd is absent:
 * install an hourly cron line (idempotent via {@link CRON_MARKER}). On macOS: print
 * the deferred notice and skip cleanly.
 *
 * The settings write (enabled=true + cadence) is best-effort: a down server is a
 * non-fatal hint (the timer is installed; the operator toggles from the dashboard
 * once the server is up). The timer is what makes auto-update actually happen.
 */
export async function enableAutoUpdate(options: EnableOptions = {}): Promise<AutoUpdateResult> {
  const platform = options.platform ?? process.platform;
  if (isUnsupportedPlatform(platform)) {
    return { output: MACOS_NOTICE };
  }

  // Validate the cadence BEFORE touching the host (a bad cadence is a teaching
  // error, not a half-installed timer). Default daily.
  const cadence = resolveCadence(options.cadence);

  const librarianPath = await resolveLibrarianPath();
  const lines: string[] = [];

  if (await hasSystemd()) {
    await installUnit(
      AUTOUPDATE_SERVICE_NAME,
      servicePath(),
      generateServiceUnit({ librarianPath }),
    );
    await installUnit(AUTOUPDATE_TIMER_NAME, timerPath(), generateTimerUnit());
    // daemon-reload BEFORE enable --now so systemd sees the (possibly rewritten)
    // units. Only the TIMER is enabled (the service is oneshot, fired by the timer).
    await sudoSystemctl(["daemon-reload"]);
    await sudoSystemctl(["enable", "--now", AUTOUPDATE_TIMER_NAME]);
    lines.push(
      `Auto-update timer installed — ${AUTOUPDATE_TIMER_NAME} fires hourly and runs the due-check.`,
      `  Units: ${servicePath()} + ${timerPath()} (no secret in either file).`,
    );
  } else {
    await installCron(librarianPath);
    lines.push(
      "Auto-update cron entry installed — runs the due-check hourly (systemd not found).",
      `  Tagged \`${CRON_MARKER}\` in your crontab (remove with \`librarian server autoupdate uninstall\`).`,
    );
  }

  // Write the enabled + cadence settings into the running server so the dashboard
  // reflects them. Best-effort — a down server is a hint, not a failure.
  const wrote = await writeRunningConfig({ enabled: true, cadence });
  if (wrote) {
    lines.push(`Enabled auto-update in the running server (cadence: ${cadence}).`);
  } else {
    lines.push(
      `Could not reach the running server to set enabled/cadence (is it up?). The timer is ` +
        `installed; enable + set the ${cadence} cadence from the dashboard, or re-run this once ` +
        `the server is up.`,
    );
  }

  return { output: lines.join("\n") };
}

/** Validate + default the cadence; a bad value is a teaching error before any host change. */
function resolveCadence(raw: string | undefined): AutoUpdateCadence {
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_AUTOUPDATE_CADENCE;
  const c = raw.trim();
  if (!isAutoUpdateCadence(c)) {
    throw new AutoUpdateError(
      `cadence must be one of ${AUTOUPDATE_CADENCES.join(" | ")}, got '${c}'.`,
    );
  }
  return c;
}

// --- disable -------------------------------------------------------------

/**
 * Disable auto-update WITHOUT removing the timer (spec §3 SC2): flip
 * `enabled=false` in the running server so the next `--run` no-ops, leaving the
 * timer installed. Idempotent. A down server is a teaching error (we can't flip a
 * setting on a server we can't reach) — the operator can also toggle it off from
 * the dashboard.
 */
export async function disableAutoUpdate(
  options: AutoUpdateOptions = {},
): Promise<AutoUpdateResult> {
  const platform = options.platform ?? process.platform;
  if (isUnsupportedPlatform(platform)) {
    return { output: MACOS_NOTICE };
  }
  const wrote = await writeRunningConfig({ enabled: false });
  if (!wrote) {
    throw new AutoUpdateError(
      "Could not reach the running server to disable auto-update. Is it up " +
        "(`librarian server status`)? You can also toggle auto-update off from the dashboard. " +
        "The host timer is left installed; once disabled, the next fire will no-op.",
    );
  }
  return {
    output: [
      "Auto-update disabled — the setting is off, so the next timer fire will no-op.",
      "The host timer is left installed; remove it entirely with `librarian server autoupdate uninstall`.",
    ].join("\n"),
  };
}

// --- uninstall -----------------------------------------------------------

/**
 * Remove the host scheduler entirely (spec §3 SC2): on systemd, `disable --now`
 * the timer (tolerating "not loaded"), remove BOTH unit files, then
 * `daemon-reload`. Where systemd is absent, strip our tagged crontab line. Safe if
 * already absent — idempotent, never a crash. Does NOT touch the server's
 * `enabled` setting (the timer is gone, so it no longer matters; leaving the
 * setting avoids a needless server round-trip on a down server). On macOS: notice.
 */
export async function uninstallAutoUpdate(
  options: AutoUpdateOptions = {},
): Promise<AutoUpdateResult> {
  const platform = options.platform ?? process.platform;
  if (isUnsupportedPlatform(platform)) {
    return { output: MACOS_NOTICE };
  }

  if (await hasSystemd()) {
    // disable --now the timer; tolerate "unit does not exist / not loaded".
    const disable = await run("sudo", ["systemctl", "disable", "--now", AUTOUPDATE_TIMER_NAME]);
    if (disable.code !== 0 && !isUnitAbsent(disable.stderr)) {
      failIfNonZero("sudo", ["systemctl", "disable", "--now", AUTOUPDATE_TIMER_NAME], disable);
    }
    // Remove both unit files (idempotent with -f), then daemon-reload.
    await sudoRun(["rm", "-f", timerPath()]);
    await sudoRun(["rm", "-f", servicePath()]);
    await sudoSystemctl(["daemon-reload"]);
    return {
      output: [
        "Auto-update timer removed — both unit files deleted and systemd reloaded.",
        "The server's auto-update setting is untouched; the container itself is unaffected.",
      ].join("\n"),
    };
  }

  await removeCron();
  return {
    output:
      "Auto-update cron entry removed (systemd not found). The container itself is unaffected.",
  };
}

// --- cron fallback (idempotent via CRON_MARKER) --------------------------

/**
 * Read the current user's crontab. `crontab -l` exits non-zero with "no crontab"
 * when the user has none — that's an empty crontab, not an error. Returns the
 * existing lines (never our marker line duplicated).
 */
async function readCrontab(): Promise<string[]> {
  const result = await run("crontab", ["-l"]);
  if (result.code !== 0) return []; // "no crontab for <user>" → empty
  return result.stdout.split("\n").filter((l) => l.length > 0);
}

/** Install (or refresh) our hourly cron line idempotently — strip any prior marker line first. */
async function installCron(librarianPath: string): Promise<void> {
  if ((await which("crontab")) === null) {
    throw new AutoUpdateError(
      "Neither systemd nor crontab was found, so there's no host scheduler to install the " +
        "auto-update timer into. Install systemd or cron, or schedule " +
        "`librarian server autoupdate --run` to run hourly yourself.",
    );
  }
  const kept = (await readCrontab()).filter((l) => !l.includes(CRON_MARKER));
  const next = [...kept, cronLine(librarianPath)].join("\n") + "\n";
  await writeCrontab(next);
}

/** Remove our tagged cron line (idempotent — a crontab without it is left as-is). */
async function removeCron(): Promise<void> {
  if ((await which("crontab")) === null) return; // nothing could have installed it
  const lines = await readCrontab();
  const kept = lines.filter((l) => !l.includes(CRON_MARKER));
  if (kept.length === lines.length) return; // our line wasn't there — nothing to do
  await writeCrontab(kept.length > 0 ? kept.join("\n") + "\n" : "");
}

/** Write a crontab via `crontab -` (reads the new content from a temp file on stdin-substitute). */
async function writeCrontab(content: string): Promise<void> {
  // `crontab <file>` installs the file as the new crontab. Write to a temp file
  // and hand its path to crontab (the runner has no stdin pipe). NON-SECRET
  // content (the marker line carries no token), so an ordinary temp file is fine.
  const dir = mkdtempSync(path.join(tmpdir(), "librarian-autoupdate-cron-"));
  const file = path.join(dir, "crontab");
  writeFileSync(file, content, "utf8");
  try {
    const result = await run("crontab", [file]);
    failIfNonZero("crontab", [file], result);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- status --------------------------------------------------------------

/**
 * Report the auto-update state (spec §3 SC3): is the timer/cron installed?, the
 * server's enabled/cadence/last-run (read from the running server), and the
 * up-to-date badge (reusing `server status`' deployed-vs-latest render). A down
 * server degrades the server-side fields to "unknown (server unreachable)" but
 * still reports the host-side timer state and exits 0.
 */
export async function autoUpdateStatus(options: AutoUpdateOptions = {}): Promise<AutoUpdateResult> {
  const platform = options.platform ?? process.platform;
  if (isUnsupportedPlatform(platform)) {
    return { output: MACOS_NOTICE };
  }

  const timerInstalled = await isTimerInstalled();
  const config = await readRunningConfig();

  const lines = ["The Librarian auto-update:", ""];
  lines.push(`  Timer installed: ${timerInstalled ? "yes" : "no"}`);
  if (config) {
    lines.push(
      `  Enabled:         ${config.enabled ? "yes" : "no"}`,
      `  Cadence:         ${config.cadence}`,
      `  Last auto-update: ${config.lastRunAt ?? "never"}`,
    );
  } else {
    lines.push(
      "  Enabled:         unknown (server unreachable)",
      "  Cadence:         unknown (server unreachable)",
      "  Last auto-update: unknown (server unreachable)",
    );
  }

  // Reuse `server status` for the deployed-vs-latest badge (offline-tolerant).
  try {
    const status = await serverStatus({
      ...(options.home !== undefined ? { home: options.home } : {}),
      ...(options.dir !== undefined ? { dir: options.dir } : {}),
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
    });
    lines.push("", status.output);
  } catch {
    // A preflight failure (no docker) shouldn't crash `autoupdate status` — the
    // host-timer state above is still useful. Note it and exit 0.
    lines.push("", "(could not read `server status` — is docker installed/running?)");
  }

  if (!timerInstalled) {
    lines.push(
      "",
      "The host timer is not installed — auto-update won't run even if enabled. " +
        "Install it with `librarian server autoupdate enable`.",
    );
  }

  return { output: lines.join("\n") };
}

/**
 * Is the host timer installed? On systemd, `systemctl list-unit-files <timer>`
 * lists it when the unit file exists; on a cron-only host, our tagged line is
 * present. Both probes go through the injectable runner. Returns false on any
 * failure (a missing scheduler → not installed).
 */
async function isTimerInstalled(): Promise<boolean> {
  if (await hasSystemd()) {
    const result = await run("systemctl", ["list-unit-files", AUTOUPDATE_TIMER_NAME]);
    // `list-unit-files <name>` prints the unit line when it exists; exit 0 + the
    // name in stdout is the "installed" signal (exit code alone is unreliable
    // across systemd versions for an absent unit).
    return result.code === 0 && result.stdout.includes(AUTOUPDATE_TIMER_NAME);
  }
  if ((await which("crontab")) === null) return false;
  return (await readCrontab()).some((l) => l.includes(CRON_MARKER));
}

// --- the `--run` wrapper (what the timer calls) --------------------------

/**
 * The wrapper the timer/cron fires (spec §3 SC4/SC7). Reads the auto-update
 * settings from the RUNNING server, applies the due-check, and conditionally runs
 * `server update`. FULLY FAIL-SOFT — it NEVER throws (the timer's unit always
 * exits 0); every outcome is one log line:
 *
 *   - Server UNREACHABLE → SKIP (never auto-update a server in an unknown state).
 *   - NOT (enabled && due) → SKIP (the no-op the disabled/not-due case wants).
 *   - enabled && due → run `server update`. On SUCCESS, stamp `last_run_at`
 *     (so the next due-check advances). On FAILURE (the update's own health-check
 *     rollback left the prior container running), log + do NOT stamp (so the next
 *     fire retries).
 *
 * The due-check is computed HOST-SIDE from the config the server returned (so the
 * single source of truth — the core helper's logic — is mirrored here without a
 * second round-trip): enabled AND the cadence has elapsed since `lastRunAt`
 * (never-run → due).
 */
export async function runAutoUpdate(options: RunOptions = {}): Promise<AutoUpdateResult> {
  const log = options.log ?? ((line: string): void => void process.stderr.write(`${line}\n`));
  const now = options.now ?? new Date();

  try {
    const config = await readRunningConfig();
    if (!config) {
      const line =
        "autoupdate: server unreachable — skipping (won't update a server in an unknown state).";
      log(line);
      return { output: line };
    }

    if (!config.enabled) {
      const line = "autoupdate: disabled — skipping.";
      log(line);
      return { output: line };
    }

    if (!isDue(now, config)) {
      const line = `autoupdate: not due yet (cadence: ${config.cadence}, last run: ${config.lastRunAt ?? "never"}) — skipping.`;
      log(line);
      return { output: line };
    }

    // Due + enabled: run the existing host-level update flow.
    try {
      const result = await runUpdate({
        ...(options.home !== undefined ? { home: options.home } : {}),
        ...(options.dir !== undefined ? { dir: options.dir } : {}),
        ...(options.healthAttempts !== undefined ? { healthAttempts: options.healthAttempts } : {}),
        ...(options.healthIntervalMs !== undefined
          ? { healthIntervalMs: options.healthIntervalMs }
          : {}),
      });
      // Stamp last_run_at ONLY on success. The server was recreated, so write the
      // stamp through the (now-fresh) container's internal tRPC. A failed stamp is
      // logged but not fatal — the update itself succeeded.
      const stamped = await stampRunInServer();
      const stampNote = stamped
        ? ""
        : " (note: could not stamp last_run_at — will re-check next fire)";
      const line = `autoupdate: updated successfully${stampNote}.`;
      log(line);
      // The inner update's own output (carries an at-most-once fresh token note).
      return { output: `${line}\n${redactSecrets(result.output)}` };
    } catch (error) {
      // The update failed — its own health-check rollback left the prior container
      // running. Do NOT stamp last_run_at (so the next fire retries). Log + exit 0.
      const detail =
        error instanceof UpdateError || error instanceof Error
          ? redactSecrets(error.message)
          : String(error);
      const line = `autoupdate: update failed — left the previous server running, did NOT stamp last_run_at (will retry next fire). ${firstLine(detail)}`;
      log(line);
      return { output: line };
    }
  } catch (error) {
    // Belt-and-braces: ANY unexpected throw is swallowed so the timer never fails.
    const detail = error instanceof Error ? redactSecrets(error.message) : String(error);
    const line = `autoupdate: unexpected error — skipping (timer continues). ${firstLine(detail)}`;
    log(line);
    return { output: line };
  }
}

/** The host-side due-check mirroring core's `isAutoUpdateDue` over the fetched config. */
function isDue(now: Date, config: RunningConfig): boolean {
  if (!config.enabled) return false;
  if (config.lastRunAt === null) return true;
  const last = new Date(config.lastRunAt);
  if (Number.isNaN(last.getTime())) return true; // corrupt → treat as never-run
  const days = config.cadence === "weekly" ? 7 : 1;
  return now.getTime() - last.getTime() >= days * 24 * 60 * 60 * 1000;
}

/** The first line of a (possibly multi-line) message — keeps the journal entry one line. */
function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}
