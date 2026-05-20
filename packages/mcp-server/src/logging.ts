// Shared pino logger for @librarian/mcp-server (T4.6).
//
// Two output modes:
//   - **TTY dev** (default when stdout is a TTY and NODE_ENV !==
//     "production"): pino-pretty transport — colourised, human-readable.
//   - **Anywhere else** (production, CI, piped stdout): raw NDJSON via
//     `pino.multistream`. info+ goes to stdout; error+ is *also*
//     mirrored to stderr so operators (and tests asserting on stderr)
//     still see fatal boot messages even when stdout is consumed by a
//     log collector.
//
// Sync `pino.destination` streams in the multistream path guarantee
// that fatal errors flush before `process.exit()` — pino-pretty's
// worker transport offers no such guarantee, which is why TTY mode is
// strictly opt-in.
//
// Level controlled by LIBRARIAN_LOG_LEVEL (default `info`); pretty
// transport disabled by `LIBRARIAN_LOG_PRETTY=false`.

import pino, { type Level, type LoggerOptions } from "pino";

const VALID_LEVELS: ReadonlySet<Level> = new Set([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
] as const);

function resolveLevel(): Level {
  const raw = process.env.LIBRARIAN_LOG_LEVEL;
  if (!raw) return "info";
  if (VALID_LEVELS.has(raw as Level)) return raw as Level;
  // Can't logger.warn here — the logger doesn't exist yet. Write the
  // warning to stderr so operators see the bad config, then fall back.
  process.stderr.write(
    `LIBRARIAN_LOG_LEVEL="${raw}" is not a valid pino level; falling back to "info".\n`,
  );
  return "info";
}

const LEVEL = resolveLevel();
const usePretty =
  process.stdout.isTTY === true &&
  process.env.NODE_ENV !== "production" &&
  process.env.LIBRARIAN_LOG_PRETTY !== "false";

function buildLogger(): pino.Logger {
  const baseOptions: LoggerOptions = {
    level: LEVEL,
    // `service` is intentionally in the `ignore` list of the pretty
    // transport (line 39) so dev output stays terse, but it's kept in
    // the NDJSON `base` so log routers can fan out by service name.
    base: { service: "the-librarian" },
  };

  if (usePretty) {
    return pino({
      ...baseOptions,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard", ignore: "pid,hostname,service" },
      },
    });
  }

  // `dedupe: true` routes each record to the single highest-level
  // matching stream — info/warn land in stdout only, error+ in stderr
  // only — so operators (and downstream aggregators) don't see every
  // fatal line twice.
  const streams: pino.StreamEntry[] = [
    { level: LEVEL, stream: pino.destination({ dest: 1, sync: true }) },
    { level: "error", stream: pino.destination({ dest: 2, sync: true }) },
  ];
  return pino(baseOptions, pino.multistream(streams, { dedupe: true }));
}

export const logger = buildLogger();

export function createLogger(bindings: Record<string, unknown>): pino.Logger {
  return logger.child(bindings);
}
