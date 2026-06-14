// `librarian server logs [-f] [--service mcp|dashboard|all]`.
//
// Maps to `docker logs [-f] the-librarian`. The all-in-one image runs BOTH
// services (mcp-server + dashboard) in ONE container under `docker/supervisor.mjs`,
// which spawns its children with `stdio: "inherit"` — so it emits NO per-service
// prefix. The two streams are interleaved with no supervisor-added label.
//
// How `--service` filtering works, given that constraint:
//   - The mcp-server logs structured pino NDJSON — every line is a JSON object
//     carrying `"service":"the-librarian"` (see packages/mcp-server/src/logging.ts).
//   - The dashboard (Next.js standalone `server.js`) logs plain text.
//   So we distinguish them by SHAPE: a line that parses as a JSON object is an
//   mcp-server line; anything else is a dashboard line. `--service mcp` keeps the
//   NDJSON lines; `--service dashboard` keeps the rest; `all` (default) is
//   unfiltered. This is the most reliable signal available without changing the
//   image to prefix each child's output.
//
// NOTE on `-f` (follow): the `docker.ts` runner CAPTURES a process's output and
// resolves on close, so a true live `docker logs -f` tail does not stream
// line-by-line through this seam — `-f` is still passed to docker (and asserted
// in tests + honoured by a future streaming runner), and the captured output is
// filtered the same way. Live streaming is a runner-level enhancement, out of
// this slice's scope.

import { run } from "./docker.js";
import { preflight } from "./preflight.js";
import { CONTAINER_NAME } from "./up.js";

/** The services `--service` can target. `all` (default) is unfiltered. */
export type LogsService = "mcp" | "dashboard" | "all";

const SERVICES: readonly LogsService[] = ["mcp", "dashboard", "all"];

export interface LogsOptions {
  /** Follow the log output (`-f` / `--follow`). */
  follow?: boolean | undefined;
  /** Which service to show. Default `all` (unfiltered). */
  service?: string | undefined;
  /** Platform for preflight's daemon hint. Default `process.platform`. */
  platform?: NodeJS.Platform | undefined;
}

/** A teaching error from `logs`; the runtime renders `.message` as one stderr line. */
export class LogsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogsError";
  }
}

export interface LogsResult {
  /** The (possibly service-filtered) log output for stdout. */
  output: string;
}

/** Validate + default the `--service` value, or throw a teaching error. */
function resolveService(raw: string | undefined): LogsService {
  if (raw === undefined) return "all";
  if ((SERVICES as readonly string[]).includes(raw)) return raw as LogsService;
  throw new LogsError(
    `Unknown --service '${raw}'. Valid values: mcp, dashboard, all (default). ` +
      "`mcp` shows the MCP server's structured logs, `dashboard` shows the Next.js " +
      "dashboard's, `all` shows both.",
  );
}

/**
 * True iff a log line is an mcp-server line — i.e. it parses as a JSON object
 * (the pino NDJSON shape). The dashboard's plain-text lines do not parse as JSON
 * objects, so they're treated as `dashboard`.
 */
function isMcpLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/** Keep only the lines belonging to `service` (preserving order + blanks for `all`). */
function filterByService(text: string, service: LogsService): string {
  if (service === "all") return text;
  const lines = text.split("\n");
  const keep =
    service === "mcp"
      ? lines.filter((l) => isMcpLine(l))
      : // dashboard: everything that isn't an mcp NDJSON line, dropping the
        // empty tail line so the output isn't padded with a blank.
        lines.filter((l) => l.trim().length > 0 && !isMcpLine(l));
  return keep.join("\n");
}

/**
 * Run `server logs`. Preflights docker, builds `docker logs [-f] the-librarian`,
 * then filters the captured output to the requested service. An unknown
 * `--service` is a teaching error; a non-zero `docker logs` exit surfaces its
 * stderr as a teaching error (e.g. "No such container").
 */
export async function runLogs(options: LogsOptions = {}): Promise<LogsResult> {
  const service = resolveService(options.service);
  await preflight(options.platform ? { platform: options.platform } : {});

  const args = ["logs"];
  if (options.follow) args.push("-f");
  args.push(CONTAINER_NAME);

  const result = await run("docker", args);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new LogsError(
      `\`docker logs ${CONTAINER_NAME}\` failed (exit ${result.code ?? "signal"})` +
        (detail ? `:\n${detail}` : ".") +
        "\n\nIs the server up? Run `librarian server status`.",
    );
  }

  return { output: filterByService(result.stdout, service) };
}
