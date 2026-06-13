// `librarian doctor` — a read-only diagnostic. Exits 0 ALWAYS (it's a
// report, not a gate), but clearly flags each problem it finds:
//   - is the agent token set? (from `readConfig`; shown only as set/not — the
//     value is NEVER printed);
//   - is the server reachable? (a GET against `<serverUrl>/healthz`, falling
//     back to `/primer.md`; INJECTABLE + offline-tolerant);
//   - which harness CLIs are on PATH? (`which` from exec.ts);
//   - the machine id + hostname (the dashboard's row key).

import { readConfig } from "./config.js";
import { which } from "./exec.js";
import { HARNESS_CLI } from "./harnesses/cli.js";
import { allHarnesses } from "./harnesses/index.js";
import { hostname, machineId } from "./machine.js";

/** Outcome of a server-reachability probe. */
export interface ProbeResult {
  ok: boolean;
  /** A short human detail: the status code, or why it failed. */
  detail: string;
}

/** The probe paths we try, in order, against the server origin. */
const PROBE_PATHS = ["/healthz", "/primer.md"] as const;
const PROBE_TIMEOUT_MS = 3000;

/**
 * Probe whether the configured server is reachable. INJECTABLE so tests never
 * hit the network; OFFLINE-TOLERANT so a down server is a flagged problem, not
 * a crash. The token is never sent here — this is an unauthenticated liveness
 * check against public endpoints.
 */
export type ServerProbe = (serverUrl: string) => Promise<ProbeResult>;

const defaultServerProbe: ServerProbe = async (serverUrl) => {
  if (!serverUrl) return { ok: false, detail: "no server URL configured" };
  let lastDetail = "unreachable";
  for (const probePath of PROBE_PATHS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const url = `${serverUrl.replace(/\/+$/, "")}${probePath}`;
      const res = await fetch(url, { method: "GET", redirect: "error", signal: controller.signal });
      if (res.ok) return { ok: true, detail: `HTTP ${res.status} ${probePath}` };
      lastDetail = `HTTP ${res.status} ${probePath}`;
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : "unreachable";
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, detail: lastDetail };
};

let serverProbe: ServerProbe = defaultServerProbe;

/** Override the server-reachability probe (tests inject a canned one). */
export function setServerProbe(next: ServerProbe): void {
  serverProbe = next;
}

/** Restore the default (network) server probe (tests). */
export function resetServerProbe(): void {
  serverProbe = defaultServerProbe;
}

/**
 * Run the diagnostic and render its report. `home` is injectable for tests.
 * Always resolves (never rejects); the caller exits 0 regardless.
 */
export async function doctor(home?: string): Promise<string> {
  const cfg = readConfig(home);
  const lines: string[] = ["librarian doctor", ""];

  // 1) Token + URL config (token shown only as set/not — never the value).
  const tokenSet = Boolean(cfg && cfg.token.length > 0);
  lines.push(
    `Token:       ${tokenSet ? "set" : "NOT SET — run `librarian config --token <token>`"}`,
  );
  lines.push(`MCP URL:     ${cfg?.mcpUrl || "NOT SET — run `librarian config --mcp-url <url>`"}`);
  lines.push(`Server URL:  ${cfg?.serverUrl || "(not set)"}`);

  // 2) Server reachability (injectable + offline-tolerant).
  const probe = await serverProbe(cfg?.serverUrl ?? "");
  lines.push(
    `Server:      ${probe.ok ? `reachable (${probe.detail})` : `UNREACHABLE — ${probe.detail}`}`,
  );

  // 3) Harness CLIs on PATH.
  lines.push("", "Harness CLIs on PATH:");
  for (const harness of allHarnesses) {
    const cli = HARNESS_CLI[harness.id];
    if (cli === null) {
      lines.push(`  ${harness.displayName}: file-based (no CLI)`);
      continue;
    }
    const found = await which(cli);
    lines.push(
      `  ${harness.displayName}: ${found ? `\`${cli}\` found` : `\`${cli}\` NOT on PATH`}`,
    );
  }

  // 4) Machine identity.
  lines.push("", `Machine id:  ${machineId(home)}`, `Hostname:    ${hostname()}`);

  const problems = !tokenSet || !cfg?.mcpUrl || !probe.ok;
  lines.push(
    "",
    problems ? "Some checks need attention (see lines flagged above)." : "All checks passed.",
  );
  return lines.join("\n");
}
