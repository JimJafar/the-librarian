// The NON-SECRET deploy-state file for the `server` command group.
//
// `up` runs the container with a chosen bind host, data volume, and ref, but
// none of that was persisted anywhere — so `update` couldn't recreate the
// container with the same config and `status` couldn't report the deployed ref
// reliably (it would have to guess via `git describe`). This file records that
// config in the deploy dir (default `~/.librarian/server/deploy-state.json`).
//
// SECURITY (AGENTS.md / spec §11): this file is NON-SECRET by construction. It
// carries ONLY non-secret fields — a bind host, a volume name (and an optional
// host data dir), a ref, an image tag, and the container name. It NEVER carries
// a bearer token, master
// key, or admin token. `writeDeployState` whitelists exactly those fields, so a
// caller that accidentally passes extra keys (a smuggled secret) cannot leak
// them into the file. The master key / admin token are surfaced to stdout once
// by `up` and persisted nowhere host-side — that contract is unchanged.

import fs from "node:fs";
import path from "node:path";

/**
 * The deploy-state recorded after a successful `up` (and rewritten by `update`).
 * Every field is NON-SECRET — see the module header. Do NOT add a token/key.
 */
export interface DeployState {
  /** The container name every `server` command operates on. */
  containerName: string;
  /** The resolved bind host the container publishes on (`127.0.0.1`, a tailnet IP, `0.0.0.0`). */
  host: string;
  /** The named data volume mounted at `/data` (sacred across `down`/`update`). */
  dataVolume: string;
  /**
   * A host directory bind-mounted at `/data` instead of the named volume, when the
   * operator chose one via `--data-dir`. Optional — absent on named-volume deploys
   * and on states written before this field existed. When set, `update` reuses it
   * and runs the container as its owner.
   */
  dataDir?: string | undefined;
  /** The deployed ref — a `vX.Y.Z` tag or `main` (what was checked out + built). */
  ref: string;
  /** The built image tag (`the-librarian:<ref>`). */
  imageTag: string;
  /**
   * The host port the dashboard is published on (`-p <host>:<dashboardPort>:3000`).
   * Optional — absent on states written before this field existed. When absent,
   * `update` treats it as the historical `3000` and backfills it, so an existing
   * server never silently changes ports under the operator; a fresh `up` defaults
   * to `3042`. Like `dataDir`, it is back-compatible (old states still validate).
   */
  dashboardPort?: number | undefined;
}

/** The keys we ever persist — the whitelist that keeps secrets out of the file. */
const STATE_KEYS = ["containerName", "host", "dataVolume", "ref", "imageTag"] as const;

/** `<dir>/deploy-state.json` — the deploy-state file path within a deploy dir. */
export function deployStatePath(dir: string): string {
  return path.join(dir, "deploy-state.json");
}

/**
 * Write the deploy-state to `<dir>/deploy-state.json`, creating `dir` if absent.
 *
 * Only the five declared fields are persisted — a `pick`, not a spread — so no
 * extra key (e.g. a smuggled token) can ride along into the file. The file is
 * non-secret, so it gets ordinary (not 0600) permissions.
 */
export function writeDeployState(dir: string, state: DeployState): void {
  fs.mkdirSync(dir, { recursive: true });
  // Pick ONLY the whitelisted keys — never spread `state`, which could carry
  // extra (secret-shaped) properties a caller smuggled in.
  const safe: DeployState = {
    containerName: state.containerName,
    host: state.host,
    dataVolume: state.dataVolume,
    ref: state.ref,
    imageTag: state.imageTag,
  };
  // Only persist the optional host data dir when one was chosen — a named-volume
  // deploy keeps the original field set (and old states stay byte-compatible).
  if (state.dataDir) safe.dataDir = state.dataDir;
  // Persist the published dashboard port when set, so `update` reuses it (a state
  // written before this field stays byte-compatible until the next write).
  if (state.dashboardPort !== undefined) safe.dashboardPort = state.dashboardPort;
  fs.writeFileSync(deployStatePath(dir), `${JSON.stringify(safe, null, 2)}\n`, "utf8");
}

/**
 * Read the deploy-state back, or `null` if the file is absent, unparseable, or
 * missing any required field. Never throws — a missing/corrupt state file means
 * the caller falls back (e.g. `status` uses `git describe`), never crashes.
 */
export function readDeployState(dir: string): DeployState | null {
  let raw: string;
  try {
    raw = fs.readFileSync(deployStatePath(dir), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  for (const key of STATE_KEYS) {
    if (typeof obj[key] !== "string") return null;
  }
  const result: DeployState = {
    containerName: obj.containerName as string,
    host: obj.host as string,
    dataVolume: obj.dataVolume as string,
    ref: obj.ref as string,
    imageTag: obj.imageTag as string,
  };
  // Optional, back-compatible: present only on `--data-dir` deploys written after
  // this field existed; left undefined otherwise (old states still validate).
  if (typeof obj.dataDir === "string") result.dataDir = obj.dataDir;
  // Optional, back-compatible: a finite integer port written after this field
  // existed. A garbage value (non-number / non-finite) is ignored — left
  // undefined so `update` falls back to the historical default rather than
  // recreating on a corrupt port.
  if (typeof obj.dashboardPort === "number" && Number.isInteger(obj.dashboardPort)) {
    result.dashboardPort = obj.dashboardPort;
  }
  return result;
}
