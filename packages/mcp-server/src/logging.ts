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

const LEVEL = (process.env.LIBRARIAN_LOG_LEVEL || "info") as Level;
const usePretty =
  process.stdout.isTTY === true &&
  process.env.NODE_ENV !== "production" &&
  process.env.LIBRARIAN_LOG_PRETTY !== "false";

function buildLogger(): pino.Logger {
  const baseOptions: LoggerOptions = {
    level: LEVEL,
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

  const streams: pino.StreamEntry[] = [
    { level: LEVEL, stream: pino.destination({ dest: 1, sync: true }) },
    { level: "error", stream: pino.destination({ dest: 2, sync: true }) },
  ];
  return pino(baseOptions, pino.multistream(streams));
}

export const logger = buildLogger();

export function createLogger(bindings: Record<string, unknown>): pino.Logger {
  return logger.child(bindings);
}
