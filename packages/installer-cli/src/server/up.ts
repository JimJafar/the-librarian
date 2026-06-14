// `librarian server up` — build + run the all-in-one container.
//
// This is the loop-closer: on a fresh Docker host it clones the monorepo at the
// resolved release tag, builds `the-librarian:<tag>`, runs the all-in-one
// container bound to the resolved host, waits for it to report healthy, surfaces
// the server-generated master key (and, beyond localhost, the admin token)
// ONCE, and prints the MCP URL + dashboard URL + a freshly minted agent token
// ready to paste into `librarian install`.
//
// Bind host (spec §5.3 / §6): the default is `127.0.0.1` (host loopback only).
// `--host <addr>` sets it explicitly. Best-effort, an interactive run with no
// `--host` is OFFERED a detected Tailscale tailnet IP. Binding to `0.0.0.0`
// (all interfaces) is ask-first. We NEVER default to `0.0.0.0`, and a
// non-interactive/`--yes` run never silently exposes the server beyond
// localhost.
//
// The bind choice drives the auth model via `LIBRARIAN_ALLOW_NO_AUTH` (the
// image always binds `0.0.0.0` internally, so the server can't see the host
// publish address — spec §6):
//   - `127.0.0.1`        → pass `-e LIBRARIAN_ALLOW_NO_AUTH=true`; the server
//                          generates NO admin token (loopback no-auth bypass).
//   - tailnet / `0.0.0.0`→ OMIT that flag; the server generates + enforces an
//                          admin token at `/data/admin.token`, read back ONCE.
//
// EVERYTHING that touches the system is injected (`docker.ts` runner — which
// also routes the Tailscale probe, the latest-release fetcher, the prompter,
// `home`, the interactivity flag, and the health-poll sleep), so the whole flow
// is exercised in tests WITHOUT a real daemon, network, git, or tailscale.
//
// Security (AGENTS.md): the agent token rides ONLY in the `docker run -e` arg
// and (if the user accepts) into `~/.librarian/env` via env.ts. The master key
// and admin token are surfaced to stdout exactly once each and are NEVER
// written to a host file or log.

import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";
import { readEnvFile, writeEnvFile } from "../env.js";
import { librarianDir } from "../paths.js";
import type { Prompter } from "../prompt.js";
import { fetchLatestVersion } from "../status.js";
import { enableBoot } from "./boot.js";
import { writeDeployState } from "./deploy-state.js";
import { run, which, type RunResult } from "./docker.js";
import { preflight } from "./preflight.js";

/** The repository the deploy dir clones (same repo the latest-tag fetch targets). */
export const REPO_URL = "https://github.com/JimJafar/the-librarian";

/** The container name every `server` command operates on (single instance per host). */
export const CONTAINER_NAME = "the-librarian";

/** The named data volume default (`--data-volume` overrides). The volume is sacred. */
export const DEFAULT_DATA_VOLUME = "librarian_data";

/** Host loopback — the default, only-reachable-locally bind (spec §5/§6). */
export const LOCALHOST = "127.0.0.1";

/** Bind-all-interfaces — never the default; ask-first (spec §5.3, §11). */
export const ALL_INTERFACES = "0.0.0.0";

/** The warning printed beside the one-time master-key surfacing (spec §5.4). */
export const SAVE_KEY_WARNING = "SAVE THIS KEY — excluded from backups";

// --- injectable health-poll sleep ---------------------------------------

/** A sleep used between health polls. Injectable so tests don't actually wait. */
export type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let sleepImpl: Sleep = realSleep;

/** Override the health-poll sleep (tests inject a no-op so polling is instant). */
export function setSleep(next: Sleep): void {
  sleepImpl = next;
}

/** Restore the real sleep (tests). */
export function resetSleep(): void {
  sleepImpl = realSleep;
}

// --- injectable agent-token mint ----------------------------------------

/** Mint one CSPRNG agent token. Injectable so tests assert a deterministic value. */
export type TokenMinter = () => string;

const realMinter: TokenMinter = () => randomBytes(32).toString("hex");

let minter: TokenMinter = realMinter;

/** Override the agent-token minter (tests). */
export function setTokenMinter(next: TokenMinter): void {
  minter = next;
}

/** Restore the real CSPRNG minter (tests). */
export function resetTokenMinter(): void {
  minter = realMinter;
}

/**
 * Mint one agent token through the CURRENT minter. Exported so `update` mints a
 * fresh token (when the old container's token can't be read back) via the same
 * injectable seam `up` uses — a single deterministic value in tests.
 */
export function mintAgentToken(): string {
  return minter();
}

// --- options + result ----------------------------------------------------

export interface UpOptions {
  /** Pinned ref (`vX.Y.Z` tag or `main`). Default: the latest release tag. */
  ref?: string | undefined;
  /** Deploy dir override. Default: `~/.librarian/server`. */
  dir?: string | undefined;
  /**
   * Bind host. Default `127.0.0.1` (loopback only). `--host <addr>` sets it
   * explicitly; `0.0.0.0` (all interfaces) is ask-first. An interactive run
   * with no `--host` may be offered a detected Tailscale IP instead (§5.3).
   */
  host?: string | undefined;
  /** Named data volume. Default: `librarian_data`. */
  dataVolume?: string | undefined;
  /**
   * Enable boot persistence after a successful `up` (S6). On Linux, installs +
   * enables the systemd unit; on macOS, prints the deferred notice and the `up`
   * still succeeds. Opt-in: a plain `up` never enables boot silently.
   */
  enableBoot?: boolean | undefined;
  /** Auto-accept prompts (loop-closer `~/.librarian/env` offer). */
  yes?: boolean | undefined;
  /** Health-wait bound: how many polls before declaring failure (small in tests). */
  healthAttempts?: number | undefined;
  /** Milliseconds between health polls (0 in tests). */
  healthIntervalMs?: number | undefined;
  /** Lines of `docker logs` to surface on a failed health-wait. */
  logTailLines?: number | undefined;
}

export interface UpDeps {
  /** Override home (tests). */
  home?: string | undefined;
  /** Prompter for the loop-closer env offer and the bind-host offers. */
  prompter: Prompter;
  /** Platform for preflight's daemon hint. Default `process.platform`. */
  platform?: NodeJS.Platform | undefined;
  /**
   * Whether the run is interactive (a TTY is attached). Gates the best-effort
   * Tailscale offer and the `0.0.0.0` confirm — a non-interactive run never
   * silently exposes the server beyond localhost. Default `true`.
   */
  interactive?: boolean | undefined;
}

/** A teaching error from `up`; the runtime renders `.message` as one stderr line. */
export class UpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpError";
  }
}

// --- the docker run argv seam -------------------------------------------

export interface RunArgsInput {
  host: string;
  dataVolume: string;
  tag: string;
  agentToken: string;
}

/**
 * Construct the `docker run` argv (everything after `docker`). The SINGLE place
 * the run vector is assembled: `LIBRARIAN_ALLOW_NO_AUTH` and the publish address
 * are both derived from `host`.
 *
 * Localhost (`127.0.0.1`) → include `-e LIBRARIAN_ALLOW_NO_AUTH=true` (no admin
 * token; loopback-only no-auth bypass — spec §6). Beyond localhost (a tailnet
 * IP or `0.0.0.0`) → OMIT the flag so the server generates + enforces an admin
 * token. The image runs `tini` as PID 1, so `--init` is deliberately omitted.
 */
export function buildRunArgs(input: RunArgsInput): string[] {
  const { host, dataVolume, tag, agentToken } = input;
  const args = [
    "run",
    "-d",
    "--name",
    CONTAINER_NAME,
    "--restart",
    "unless-stopped",
    "-p",
    `${host}:3000:3000`,
    "-p",
    `${host}:3838:3838`,
    "-v",
    `${dataVolume}:/data`,
    "-e",
    `LIBRARIAN_AGENT_TOKEN=${agentToken}`,
  ];
  if (host === LOCALHOST) {
    args.push("-e", "LIBRARIAN_ALLOW_NO_AUTH=true");
  }
  args.push(`${CONTAINER_NAME}:${tag}`);
  return args;
}

// --- the up flow ---------------------------------------------------------

export interface UpResult {
  /** Human-readable report for stdout (carries the master key ONCE). */
  output: string;
}

/**
 * Run `server up`. Throws `UpError` (teaching message) on any failure; on a
 * failed health-wait it rolls the container back first so no half-up state is
 * left behind. Works for any resolved bind host (loopback / tailnet / all
 * interfaces); the bind choice drives the auth model (§6).
 */
export async function runUp(options: UpOptions, deps: UpDeps): Promise<UpResult> {
  // 1) Preflight: docker (daemon reachable) + git, or a teaching error.
  await preflight(deps.platform ? { platform: deps.platform } : {});

  // 2) Resolve the bind host (default loopback; Tailscale offer; `0.0.0.0`
  //    ask-first). May throw `UpError` if the user declines a `0.0.0.0` bind —
  //    BEFORE any clone/build/run, so a declined exposure leaves nothing behind.
  const host = await resolveBindHost(options, deps);

  const dataVolume = options.dataVolume ?? DEFAULT_DATA_VOLUME;
  const deployDir = options.dir ?? path.join(librarianDir(deps.home), "server");

  // 3) Resolve the ref (default = latest release tag), then the deploy dir.
  const tag = await resolveRef(options.ref);
  await prepareDeployDir(deployDir, tag);

  // 4) Mint the agent token (the loop-closer). Never logged.
  const agentToken = minter();

  // 5) Build the image, then run the container.
  await build(deployDir, tag);
  await dockerRun(buildRunArgs({ host, dataVolume, tag, agentToken }), deployDir);

  // 6+7) Wait for health, then read back the server-generated secrets. ANY
  //      failure in this post-`docker run` phase — a timeout/unhealthy report,
  //      an exception from `docker inspect`/`sleep`, or a failed secret read —
  //      MUST force-remove the container so no half-up state is left behind
  //      (spec §11). `waitForHealthy` already rolls back on its own
  //      timeout/unhealthy path; this guard catches the throwing cases it
  //      can't (the second `rm -f` is best-effort + idempotent).
  let secrets: ContainerSecrets;
  try {
    await waitForHealthy(options);
    secrets = await readSecrets(host);
  } catch (error) {
    await run("docker", ["rm", "-f", CONTAINER_NAME]).catch(() => undefined);
    throw error;
  }

  // 7b) Persist the NON-SECRET deploy-state so `update` can recreate the
  //     container with the same config and `status` can report the deployed
  //     ref reliably. This carries the bind host / data volume / ref / image
  //     tag / container name — NEVER a token or key (deploy-state.ts whitelists
  //     the fields). Only after a confirmed-healthy run, so the recorded state
  //     reflects a container that actually came up.
  writeDeployState(deployDir, {
    containerName: CONTAINER_NAME,
    host,
    dataVolume,
    ref: tag,
    imageTag: `${CONTAINER_NAME}:${tag}`,
  });

  // 8) Boot persistence (opt-in, spec §5.8). With `--enable-boot`, install +
  //    enable the systemd unit AFTER a healthy up (so the named container the
  //    unit references actually exists). On macOS this prints the deferred
  //    notice and continues — the `up` still succeeds. The unit references the
  //    EXISTING container by name and carries NO secret (boot.ts).
  const lines: string[] = [];
  if (options.enableBoot) {
    const bootResult = await enableBoot(deps.platform ? { platform: deps.platform } : {});
    lines.push(bootResult.output, "");
  }

  // 9) Close the loop: surface secrets/URLs + offer the local env write.
  await closeTheLoop(lines, { host, agentToken, secrets, options, deps });

  return { output: lines.join("\n") };
}

// --- bind-host resolution (spec §5.3, §6) -------------------------------

/**
 * Resolve the host the container publishes on:
 *   - `--host <addr>` wins (explicit). `0.0.0.0` is still ask-first.
 *   - no `--host`, interactive, not `--yes`, and `tailscale ip -4` yields a
 *     tailnet IP → OFFER it (default: keep loopback).
 *   - otherwise → `127.0.0.1` (we never silently expose beyond localhost).
 *
 * Binding to `0.0.0.0` requires explicit confirmation (`--yes` auto-accepts);
 * declining aborts with a teaching error BEFORE any clone/build/run.
 */
async function resolveBindHost(options: UpOptions, deps: UpDeps): Promise<string> {
  // An empty/whitespace `--host` (e.g. `--host ""`) is treated as "not provided"
  // rather than slipping through as `""` — which would publish `-p :3000:3000`
  // (ALL interfaces) with no ask-first (I1). Fall through to the default path.
  if (options.host !== undefined && options.host.trim().length > 0) {
    const host = normalizeHost(options.host.trim());
    if (host === ALL_INTERFACES) {
      await confirmAllInterfaces(options, deps);
    } else if (isIpv6Literal(host)) {
      // `::1` already normalized to loopback above; any OTHER IPv6 literal is
      // beyond this slice's scope (the `-p` arg would need bracketing and the
      // exposure path would need IPv6 reasoning). Teach rather than emit a
      // malformed `-p ::ffff:…:3000:3000`.
      throw new UpError(
        `IPv6 bind addresses other than loopback (::1) are not supported yet (got '${host}'). ` +
          "Use an IPv4 address (e.g. a tailnet IP) or '0.0.0.0' to bind all interfaces.",
      );
    }
    return host;
  }

  // No explicit host: best-effort offer the Tailscale IP (interactive only).
  const interactive = deps.interactive ?? true;
  if (interactive && options.yes !== true) {
    const tailnetIp = await detectTailscaleIp();
    if (tailnetIp) {
      const answer = await deps.prompter.promptText(
        `Detected a Tailscale address (${tailnetIp}). Bind the server to it so your ` +
          `tailnet can reach it (instead of localhost only)? [y/N]`,
        { default: "n" },
      );
      if (isYes(answer)) return tailnetIp;
    }
  }

  return LOCALHOST;
}

/**
 * Normalize loopback spellings to the canonical `127.0.0.1` (I3). The server
 * treats `localhost` / `::1` / `127.0.0.1` identically (loopback no-auth bypass),
 * so the CLI must too — otherwise `--host localhost` would omit `ALLOW_NO_AUTH`
 * and try to read an admin token that the server never minted. Any other value
 * is returned unchanged (the caller decides whether it's allowed).
 */
function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower === "::1" || lower === LOCALHOST) return LOCALHOST;
  return host;
}

/** True for a genuine IPv6 literal (after loopback normalization). */
function isIpv6Literal(host: string): boolean {
  return isIP(host) === 6;
}

/**
 * Confirm an all-interfaces (`0.0.0.0`) bind. `--yes` auto-accepts; otherwise
 * prompt (default no). Declining throws `UpError` — exposing every interface is
 * never something we do without an explicit yes.
 */
async function confirmAllInterfaces(options: UpOptions, deps: UpDeps): Promise<void> {
  if (options.yes === true) return;

  const answer = await deps.prompter.promptText(
    `Binding to 0.0.0.0 exposes the server on ALL network interfaces — anyone who ` +
      `can reach this machine can reach it. Continue? [y/N]`,
    { default: "n" },
  );
  if (!isYes(answer)) {
    throw new UpError(
      "Aborted: binding to 0.0.0.0 (all interfaces) was declined. " +
        "Re-run without --host for a localhost-only server, or with --host <tailnet-ip> " +
        "for a specific reachable address.",
    );
  }
}

/**
 * Best-effort probe for this machine's Tailscale IPv4 address, routed through
 * the injectable `docker.ts` runner (so tests stub it; no real tailscale).
 * Returns `null` when `tailscale` is absent or yields no usable IPv4 — the
 * caller then stays on loopback. Never throws: a probe failure is silent.
 */
async function detectTailscaleIp(): Promise<string | null> {
  if ((await which("tailscale")) === null) return null;
  try {
    const result = await run("tailscale", ["ip", "-4"]);
    if (result.code !== 0) return null;
    // Use `node:net` `isIP` so invalid octets (e.g. `999.1.2.3`) are rejected —
    // a loose `\d{1,3}` regex would accept them (S1).
    const ip = result.stdout
      .split("\n")
      .map((l) => l.trim())
      .find((l) => isIP(l) === 4);
    return ip ?? null;
  } catch {
    return null;
  }
}

// --- step helpers --------------------------------------------------------

/** Resolve the ref to deploy: an explicit `--ref` wins; else the latest tag. */
async function resolveRef(ref: string | undefined): Promise<string> {
  if (ref && ref.trim().length > 0) return ref.trim();
  const latest = await fetchLatestVersion();
  if (!latest) {
    throw new UpError(
      "Could not resolve the latest release tag from GitHub. " +
        "Check your network, or pin a ref with `--ref <tag|main>`.",
    );
  }
  // `fetchLatestVersion` strips the leading `v`; the tag we check out keeps it.
  return `v${latest}`;
}

/**
 * Ready the deploy dir at `tag`:
 *   - absent → `git clone <repo> <dir>` then checkout the ref;
 *   - already OUR managed clone → `git fetch` + checkout the ref;
 *   - exists but isn't our clone (different remote / dirty) → STOP and ask.
 * Never clobbers a dir we didn't create.
 */
async function prepareDeployDir(dir: string, tag: string): Promise<void> {
  const gitDir = path.join(dir, ".git");
  if (!(await pathExists(gitDir))) {
    if (await pathExists(dir)) {
      // A non-empty dir that isn't a git repo → not ours; don't clobber.
      if (!(await isEmptyDir(dir))) {
        throw new UpError(
          `Deploy dir ${dir} exists but is not a Librarian clone (no .git). ` +
            "Refusing to overwrite a directory I didn't create — " +
            "remove it or choose another path with `--dir <path>`.",
        );
      }
    }
    await git(["clone", REPO_URL, dir]);
    await git(["-C", dir, "checkout", tag]);
    return;
  }

  // It's a git repo — confirm it's OUR clone before touching it.
  const originResult = await run("git", ["-C", dir, "remote", "get-url", "origin"]);
  const origin = originResult.stdout.trim();
  if (!sameRepo(origin, REPO_URL)) {
    throw new UpError(
      `Deploy dir ${dir} is a git repo with a different remote (${origin || "none"}). ` +
        "Refusing to touch a clone I didn't create — choose another path with `--dir <path>`.",
    );
  }
  await git(["-C", dir, "fetch", "--tags", "origin"]);
  await git(["-C", dir, "checkout", tag]);
}

/** True iff `origin` points at the same repo as `REPO_URL` (scheme/.git tolerant). */
function sameRepo(origin: string, repo: string): boolean {
  const norm = (u: string): string =>
    u
      .trim()
      .replace(/\.git$/, "")
      .replace(/\/$/, "")
      .replace(/^git@github\.com:/, "https://github.com/")
      .toLowerCase();
  return norm(origin) === norm(repo);
}

/** Build the all-in-one image from the deploy dir (the VERIFIED build command). */
async function build(deployDir: string, tag: string): Promise<void> {
  await dockerInDir(
    ["build", "-f", "docker/all-in-one.Dockerfile", "-t", `${CONTAINER_NAME}:${tag}`, "."],
    deployDir,
  );
}

/** Run the container (the assembled run argv) from the deploy dir. */
async function dockerRun(args: string[], deployDir: string): Promise<void> {
  await dockerInDir(args, deployDir);
}

/**
 * Health-wait tuning shared by `up` and `update` (the bounded poll + log-tail).
 * A subset of `UpOptions` so `update` can reuse {@link waitForHealthy} without
 * importing the whole `UpOptions` shape.
 */
export interface HealthWaitOptions {
  /** Health-wait bound: how many polls before declaring failure (small in tests). */
  healthAttempts?: number | undefined;
  /** Milliseconds between health polls (0 in tests). */
  healthIntervalMs?: number | undefined;
  /** Lines of `docker logs` to surface on a failed health-wait. */
  logTailLines?: number | undefined;
}

/**
 * Poll `docker inspect … Health.Status` until `healthy`, bounded. On timeout or
 * an unhealthy report: surface `docker logs --tail` (REDACTED), roll the
 * container back (`docker rm -f`), and throw — leaving NO half-up container.
 *
 * Exported so `update` recreates with the IDENTICAL health-wait + rollback
 * pattern (a failed recreate force-removes the new container and never advances
 * deploy-state). The thrown `UpError`'s message is already secret-redacted.
 */
export async function waitForHealthy(options: HealthWaitOptions): Promise<void> {
  const attempts = options.healthAttempts ?? 60;
  const intervalMs = options.healthIntervalMs ?? 2000;
  const tail = options.logTailLines ?? 50;

  for (let i = 0; i < attempts; i += 1) {
    const result = await run("docker", [
      "inspect",
      "--format",
      "{{.State.Health.Status}}",
      CONTAINER_NAME,
    ]);
    const state = result.stdout.trim();
    if (state === "healthy") return;
    if (state === "unhealthy") break; // no point waiting out the bound
    if (i < attempts - 1) await sleepImpl(intervalMs);
  }

  // Failed: surface the recent logs for triage, but REDACT first. On a fresh
  // beyond-localhost boot the server logs the generated admin token BY VALUE
  // (the one sanctioned generation notice — http.ts); that line, and any bearer
  // token in the captured output, must NEVER reach an error message (spec §5.6
  // wants logs surfaced, just not secrets). Then roll back so no half-up
  // container survives.
  const logs = await run("docker", ["logs", "--tail", String(tail), CONTAINER_NAME]);
  await run("docker", ["rm", "-f", CONTAINER_NAME]);

  const detail = redactSecrets(logs.stdout.trim() || logs.stderr.trim());
  throw new UpError(
    `The server did not become healthy in time and was rolled back ` +
      `(container removed; the data volume is untouched). Recent logs:\n` +
      (detail ? detail : "(no log output captured)") +
      `\n\nFix the cause above, then re-run \`librarian server up\`.`,
  );
}

/**
 * Strip secrets from captured `docker logs` before they reach a user-facing
 * error (C1). The server's one-time admin-token generation notice emits the
 * token BY VALUE (`packages/mcp-server/src/bin/http.ts`); the master-key notice
 * does not. We defend three ways:
 *   - drop any whole line carrying the admin-token generation notice;
 *   - redact any `libadmin_<base64url>` token substring (the bearer shape);
 *   - defensively redact any standalone 64-hex run (a raw key/token shape).
 * The redacted tail is still surfaced so debugging works — just without secrets.
 */
export function redactSecrets(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/Generated a new admin token/i.test(line))
    .join("\n")
    .replace(/libadmin_[A-Za-z0-9_-]+/g, "[redacted-admin-token]")
    .replace(/\b[0-9a-fA-F]{64}\b/g, "[redacted]");
}

/** The server-generated secrets read back after the container is healthy. */
interface ContainerSecrets {
  /** The master key from `/data/secret.key` (always present). */
  masterKey: string;
  /**
   * The admin token from `/data/admin.token` — present ONLY when bound beyond
   * localhost (the server generates it then; on localhost it generates none).
   */
  adminToken?: string;
}

/**
 * Read the server-generated secrets from the container: the master key from
 * `/data/secret.key` always, and — when bound beyond localhost — the admin
 * token from `/data/admin.token`. Neither is ever written to a host file or log.
 */
async function readSecrets(host: string): Promise<ContainerSecrets> {
  const masterKey = await readMasterKey();
  if (host === LOCALHOST) return { masterKey };
  return { masterKey, adminToken: await readAdminToken() };
}

/** Read the server-generated master key from `/data/secret.key`. */
async function readMasterKey(): Promise<string> {
  const result = await run("docker", ["exec", CONTAINER_NAME, "cat", "/data/secret.key"]);
  const key = result.stdout.trim();
  if (!key) {
    throw new UpError(
      "The server became healthy but no master key was found at /data/secret.key. " +
        "This is unexpected — check `librarian server logs`.",
    );
  }
  return key;
}

/**
 * Read the server-generated admin token from `/data/admin.token` (present only
 * when bound beyond localhost — the server mints it on first boot then). An
 * empty read is unexpected for a beyond-localhost bind, so it teaches.
 */
async function readAdminToken(): Promise<string> {
  const result = await run("docker", ["exec", CONTAINER_NAME, "cat", "/data/admin.token"]);
  const token = result.stdout.trim();
  if (!token) {
    throw new UpError(
      "The server became healthy but no admin token was found at /data/admin.token. " +
        "An admin token is expected when binding beyond localhost — check `librarian server logs`.",
    );
  }
  return token;
}

/**
 * Close the loop: surface the master key ONCE (with the SAVE warning) — and,
 * when bound beyond localhost, the admin token ONCE — print the MCP + dashboard
 * URLs and the minted agent token, and OFFER to write this machine's
 * `~/.librarian/env` when it's absent/incomplete (`--yes` auto-accepts).
 */
async function closeTheLoop(
  lines: string[],
  ctx: {
    host: string;
    agentToken: string;
    secrets: ContainerSecrets;
    options: UpOptions;
    deps: UpDeps;
  },
): Promise<void> {
  const { host, agentToken, secrets, options, deps } = ctx;
  const mcpUrl = `http://${host}:3838/mcp`;
  const dashboardUrl = `http://${host}:3000`;

  lines.push(
    "The Librarian server is up and healthy.",
    "",
    `  MCP URL:     ${mcpUrl}`,
    `  Dashboard:   ${dashboardUrl}`,
    `  Agent token: ${agentToken}`,
    "",
  );

  // `0.0.0.0` is a bind directive, not a connectable address — point clients at
  // the machine's real reachable IP rather than over-engineering auto-detection.
  if (host === ALL_INTERFACES) {
    // S2: a `--yes` run auto-accepts the all-interfaces bind with no prompt, so
    // print a one-line trace of that exposure — otherwise it's invisible in CI
    // logs (the only record of "we bound every interface, unattended").
    if (options.yes === true) {
      lines.push("Note: binding 0.0.0.0 (all interfaces) — auto-accepted via --yes.", "");
    }
    lines.push(
      "Note: 0.0.0.0 binds every interface but is NOT a connectable address — " +
        "clients should use this machine's reachable LAN/tailnet IP in the URLs above.",
      "",
    );
  }

  lines.push(
    "Paste the MCP URL + agent token into `librarian install` on your clients.",
    "",
    // The ONE-TIME master-key surfacing. Never written to a host file or log.
    `Master key (${SAVE_KEY_WARNING}):`,
    `  ${secrets.masterKey}`,
    "",
  );

  // Beyond localhost the server enforces auth: surface the admin token ONCE.
  if (secrets.adminToken) {
    lines.push(
      "Admin token (surfaced once — not stored anywhere on this host):",
      `  ${secrets.adminToken}`,
      "  Paste it into the dashboard to enable auth, or use it for `librarian server admin auth`.",
      "",
    );
  }

  await offerLocalEnv(lines, { mcpUrl, agentToken, options, deps });
}

/**
 * Offer to write this machine's own `~/.librarian/env` (so single-box dev gets
 * server + client in one shot). OFFER, never force: prompt (default no), or
 * auto-accept with `--yes`. Reuses env.ts so the token lands chmod-600 and is
 * never logged. Only offers when the env is absent/incomplete.
 */
async function offerLocalEnv(
  lines: string[],
  ctx: {
    mcpUrl: string;
    agentToken: string;
    options: UpOptions;
    deps: UpDeps;
  },
): Promise<void> {
  const { mcpUrl, agentToken, options, deps } = ctx;
  const existing = readEnvFile(deps.home);
  const complete = Boolean(existing?.mcpUrl && existing?.token);
  if (complete) {
    lines.push("This machine's `~/.librarian/env` is already configured — left as is.");
    return;
  }

  let accepted = options.yes === true;
  if (!accepted) {
    const answer = await deps.prompter.promptText(
      "Write this machine's own ~/.librarian/env so local agents use this server? [y/N]",
      { default: "n" },
    );
    accepted = isYes(answer);
  }

  if (accepted) {
    writeEnvFile({ mcpUrl, token: agentToken }, deps.home);
    lines.push("Wrote ~/.librarian/env (chmod 600) — local agents now point at this server.");
  } else {
    lines.push(
      "Left ~/.librarian/env untouched. Configure a client later with:",
      `  librarian config --mcp-url ${mcpUrl} --token <the agent token above>`,
    );
  }
}

function isYes(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return a === "y" || a === "yes";
}

// --- thin runner wrappers (teaching errors on a non-zero exit) ----------

/** Run a `git …` command from anywhere; a non-zero exit is a teaching error. */
async function git(args: string[]): Promise<void> {
  const result = await run("git", args);
  failIfNonZero("git", args, result);
}

/** Run a `docker …` command from the deploy dir; non-zero exit → teaching error. */
async function dockerInDir(args: string[], cwd: string): Promise<void> {
  const result = await run("docker", args, { cwd });
  failIfNonZero("docker", args, result);
}

function failIfNonZero(cmd: string, args: string[], result: RunResult): void {
  if (result.code === 0) return;
  const detail = result.stderr.trim() || result.stdout.trim();
  throw new UpError(
    `\`${cmd} ${args[0]}\` failed (exit ${result.code ?? "signal"})` +
      (detail ? `:\n${detail}` : ".") +
      "\n\nResolve the error above, then re-run `librarian server up`.",
  );
}

// --- tiny fs probes (kept here so the flow stays self-contained) ---------

async function pathExists(p: string): Promise<boolean> {
  const fs = await import("node:fs/promises");
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function isEmptyDir(p: string): Promise<boolean> {
  const fs = await import("node:fs/promises");
  try {
    const entries = await fs.readdir(p);
    return entries.length === 0;
  } catch {
    return false;
  }
}
