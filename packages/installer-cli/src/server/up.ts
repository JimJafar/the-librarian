// `librarian server up` — build + run the all-in-one container (localhost path).
//
// This is the loop-closer: on a fresh Docker host it clones the monorepo at the
// resolved release tag, builds `the-librarian:<tag>`, runs the all-in-one
// container bound to host loopback, waits for it to report healthy, surfaces the
// server-generated master key ONCE, and prints the MCP URL + dashboard URL + a
// freshly minted agent token ready to paste into `librarian install`.
//
// S2 implements ONLY the localhost (`127.0.0.1`) happy path. The flow is
// structured so S3 can cleanly add beyond-localhost binding (`--host`) and
// admin-token surfacing:
//   - `buildRunArgs({ host, … })` is the single place the `docker run` argv is
//     constructed; S3 makes the `LIBRARIAN_ALLOW_NO_AUTH` flag + the publish
//     address conditional on `host` there.
//   - the post-health secret read (`readMasterKey`) is the seam S3 extends to
//     also read `/data/admin.token` when bound beyond localhost.
//
// EVERYTHING that touches the system is injected (`docker.ts` runner, the
// latest-release fetcher, the prompter, `home`, and the health-poll sleep), so
// the whole flow is exercised in tests WITHOUT a real daemon, network, or git.
//
// Security (AGENTS.md): the agent token rides ONLY in the `docker run -e` arg
// and (if the user accepts) into `~/.librarian/env` via env.ts. The master key
// is surfaced to stdout exactly once and is NEVER written to a host file or log.

import { randomBytes } from "node:crypto";
import path from "node:path";
import { readEnvFile, writeEnvFile } from "../env.js";
import { librarianDir } from "../paths.js";
import type { Prompter } from "../prompt.js";
import { fetchLatestVersion } from "../status.js";
import { run, type RunResult } from "./docker.js";
import { preflight } from "./preflight.js";

/** The repository the deploy dir clones (same repo the latest-tag fetch targets). */
export const REPO_URL = "https://github.com/JimJafar/the-librarian";

/** The container name every `server` command operates on (single instance per host). */
export const CONTAINER_NAME = "the-librarian";

/** The named data volume default (`--data-volume` overrides). The volume is sacred. */
export const DEFAULT_DATA_VOLUME = "librarian_data";

/** Host loopback — the default, only-reachable-locally bind (spec §5/§6). */
export const LOCALHOST = "127.0.0.1";

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

// --- options + result ----------------------------------------------------

export interface UpOptions {
  /** Pinned ref (`vX.Y.Z` tag or `main`). Default: the latest release tag. */
  ref?: string | undefined;
  /** Deploy dir override. Default: `~/.librarian/server`. */
  dir?: string | undefined;
  /** Bind host. S2 only implements the localhost path (`127.0.0.1`). */
  host?: string | undefined;
  /** Named data volume. Default: `librarian_data`. */
  dataVolume?: string | undefined;
  /** Enable boot persistence — wired as a known flag; deferred to S6 (no-op here). */
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
  /** Prompter for the loop-closer env offer. */
  prompter: Prompter;
  /** Platform for preflight's daemon hint. Default `process.platform`. */
  platform?: NodeJS.Platform | undefined;
}

/** A teaching error from `up`; the runtime renders `.message` as one stderr line. */
export class UpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpError";
  }
}

// --- the docker run argv seam (S3 extends this) -------------------------

export interface RunArgsInput {
  host: string;
  dataVolume: string;
  tag: string;
  agentToken: string;
}

/**
 * Construct the `docker run` argv (everything after `docker`). The SINGLE place
 * the run vector is assembled, so S3 can make `LIBRARIAN_ALLOW_NO_AUTH` and the
 * publish address conditional on `host` without touching the orchestration.
 *
 * Localhost (`127.0.0.1`) → include `-e LIBRARIAN_ALLOW_NO_AUTH=true` (no admin
 * token; loopback-only no-auth bypass — spec §6). The image runs `tini` as PID
 * 1, so `--init` is deliberately omitted.
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
 * Run `server up` (localhost happy path). Throws `UpError` (teaching message)
 * on any failure; on a failed health-wait it rolls the container back first so
 * no half-up state is left behind.
 */
export async function runUp(options: UpOptions, deps: UpDeps): Promise<UpResult> {
  const host = options.host ?? LOCALHOST;
  if (host !== LOCALHOST) {
    // S3 owns beyond-localhost binding (admin-token surfacing, `0.0.0.0`
    // ask-first). Refuse rather than silently doing the wrong thing.
    throw new UpError(
      `Binding beyond ${LOCALHOST} (got --host ${host}) is not available yet — ` +
        `this slice implements the localhost path only. Re-run without --host.`,
    );
  }

  // 1) Preflight: docker (daemon reachable) + git, or a teaching error.
  await preflight(deps.platform ? { platform: deps.platform } : {});

  const dataVolume = options.dataVolume ?? DEFAULT_DATA_VOLUME;
  const deployDir = options.dir ?? path.join(librarianDir(deps.home), "server");

  // 2) Resolve the ref (default = latest release tag), then the deploy dir.
  const tag = await resolveRef(options.ref);
  await prepareDeployDir(deployDir, tag);

  // 3) Mint the agent token (the loop-closer). Never logged.
  const agentToken = minter();

  // 4) Build the image, then run the container.
  await build(deployDir, tag);
  await dockerRun(buildRunArgs({ host, dataVolume, tag, agentToken }), deployDir);

  // 5) Wait for health; roll back (and surface logs) on failure — no half-up.
  await waitForHealthy(options);

  // 6) Read the server-generated master key back from the container.
  const masterKey = await readMasterKey();

  // 7) `--enable-boot` is wired but deferred to S6.
  const lines: string[] = [];
  if (options.enableBoot) {
    lines.push(
      "Note: --enable-boot is recognised but boot persistence arrives in a later slice; skipping.",
      "",
    );
  }

  // 8) Close the loop: surface secrets/URLs + offer the local env write.
  await closeTheLoop(lines, { host, agentToken, masterKey, options, deps });

  return { output: lines.join("\n") };
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
 * Poll `docker inspect … Health.Status` until `healthy`, bounded. On timeout or
 * an unhealthy report: surface `docker logs --tail`, roll the container back
 * (`docker rm -f`), and throw — leaving NO half-up container.
 */
async function waitForHealthy(options: UpOptions): Promise<void> {
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

  // Failed: surface logs (NOT the streams — they may carry secrets-shaped lines
  // we don't echo; we hand the operator the command output for triage), then
  // roll back so no half-up container survives.
  const logs = await run("docker", ["logs", "--tail", String(tail), CONTAINER_NAME]);
  await run("docker", ["rm", "-f", CONTAINER_NAME]);

  const detail = logs.stdout.trim() || logs.stderr.trim();
  throw new UpError(
    `The server did not become healthy in time and was rolled back ` +
      `(container removed; the data volume is untouched). Recent logs:\n` +
      (detail ? detail : "(no log output captured)") +
      `\n\nFix the cause above, then re-run \`librarian server up\`.`,
  );
}

/**
 * Read the server-generated master key from `/data/secret.key`. The seam S3
 * extends to also read `/data/admin.token` when bound beyond localhost.
 */
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
 * Close the loop: surface the master key ONCE (with the SAVE warning), print the
 * MCP + dashboard URLs and the minted agent token, and OFFER to write this
 * machine's `~/.librarian/env` when it's absent/incomplete (`--yes` auto-accepts).
 */
async function closeTheLoop(
  lines: string[],
  ctx: {
    host: string;
    agentToken: string;
    masterKey: string;
    options: UpOptions;
    deps: UpDeps;
  },
): Promise<void> {
  const { host, agentToken, masterKey, options, deps } = ctx;
  const mcpUrl = `http://${host}:3838/mcp`;
  const dashboardUrl = `http://${host}:3000`;

  lines.push(
    "The Librarian server is up and healthy.",
    "",
    `  MCP URL:     ${mcpUrl}`,
    `  Dashboard:   ${dashboardUrl}`,
    `  Agent token: ${agentToken}`,
    "",
    "Paste the MCP URL + agent token into `librarian install` on your clients.",
    "",
    // The ONE-TIME master-key surfacing. Never written to a host file or log.
    `Master key (${SAVE_KEY_WARNING}):`,
    `  ${masterKey}`,
    "",
  );

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
