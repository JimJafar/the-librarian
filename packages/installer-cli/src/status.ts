// `librarian status` — live-probe every harness and render a plain table.
//
// Columns: harness · installed · version · latest · update? · url.
//   - installed/version come from each harness's live `detect()` (never a
//     cached file — spec §9);
//   - `latest` is the monorepo's latest GitHub release tag, fetched once and
//     shared across rows;
//   - `update?` is `yes`/`no`/`?` — `?` whenever the installed version or the
//     latest version is unknown, so an offline run never lies;
//   - `url` is the configured MCP URL (from `readConfig`), shown only when a
//     harness is installed.
//
// The "latest" fetch is INJECTABLE (`setLatestFetcher`) and OFFLINE-TOLERANT:
// any failure resolves to `null`, latest renders `unknown`, and `update?`
// renders `?`. The CLI never crashes because GitHub was unreachable.

import { readConfig } from "./config.js";
import { allHarnesses, type DetectResult, type HarnessModule } from "./harnesses/index.js";
import { isBehind } from "./semver.js";

/** GitHub releases API for the monorepo (latest published release). */
const LATEST_RELEASE_URL = "https://api.github.com/repos/JimJafar/the-librarian/releases/latest";
/** A short timeout so an unreachable network never hangs `status`. */
const FETCH_TIMEOUT_MS = 3000;

/**
 * Resolve the monorepo's latest release version (the tag, `v`-stripped), or
 * `null` on ANY failure (offline, timeout, non-2xx, unparseable). Injectable
 * so tests never hit the network.
 */
export type LatestFetcher = () => Promise<string | null>;

const defaultLatestFetcher: LatestFetcher = async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(LATEST_RELEASE_URL, {
      redirect: "error",
      signal: controller.signal,
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_name?: unknown };
    const tag = typeof body.tag_name === "string" ? body.tag_name.trim() : "";
    if (!tag) return null;
    return tag.replace(/^v/i, "");
  } catch {
    // Offline, DNS failure, timeout, redirect, bad JSON — all → unknown.
    return null;
  } finally {
    clearTimeout(timer);
  }
};

let latestFetcher: LatestFetcher = defaultLatestFetcher;

/** Override the latest-version fetcher (tests inject a canned/failing one). */
export function setLatestFetcher(next: LatestFetcher): void {
  latestFetcher = next;
}

/** Restore the default (network) latest-version fetcher (tests). */
export function resetLatestFetcher(): void {
  latestFetcher = defaultLatestFetcher;
}

/** The default fetcher, exported for direct use / testing of the GET itself. */
export const fetchLatestVersion: LatestFetcher = () => latestFetcher();

interface StatusRow {
  harness: string;
  installed: boolean;
  version: string;
  latest: string;
  update: "yes" | "no" | "?";
  url: string;
}

/**
 * Probe every harness in parallel and the latest version once, returning the
 * rendered table. `home` is injectable for tests.
 */
export async function status(home?: string): Promise<string> {
  const [detections, latest] = await Promise.all([
    Promise.all(allHarnesses.map((h) => h.detect())),
    fetchLatestVersion(),
  ]);
  const cfg = readConfig(home);
  const mcpUrl = cfg?.mcpUrl ?? "";

  const rows = allHarnesses.map((h, i) =>
    toRow(h, detections[i] ?? { installed: false }, latest, mcpUrl),
  );
  return renderTable(rows, latest);
}

function toRow(
  harness: HarnessModule,
  detect: DetectResult,
  latest: string | null,
  mcpUrl: string,
): StatusRow {
  const version = detect.version ?? "";
  const update: StatusRow["update"] = !detect.installed
    ? "no"
    : !version || !latest
      ? "?"
      : isBehind(version, latest)
        ? "yes"
        : "no";
  return {
    harness: harness.displayName,
    installed: detect.installed,
    version: detect.installed ? version || "(unknown)" : "—",
    latest: latest ?? "unknown",
    update,
    url: detect.installed ? mcpUrl || "—" : "—",
  };
}

// --- plain-text table rendering (aligned, no table lib) ------------------

const HEADERS = ["HARNESS", "INSTALLED", "VERSION", "LATEST", "UPDATE?", "URL"] as const;

function renderTable(rows: StatusRow[], latest: string | null): string {
  const cells: string[][] = rows.map((r) => [
    r.harness,
    r.installed ? "yes" : "no",
    r.version,
    r.latest,
    r.update,
    r.url,
  ]);
  const widths = HEADERS.map((h, col) =>
    Math.max(h.length, ...cells.map((row) => (row[col] ?? "").length)),
  );
  const line = (parts: readonly string[]): string =>
    parts
      .map((part, col) => part.padEnd(widths[col] ?? part.length))
      .join("  ")
      .trimEnd();

  const out = [line(HEADERS), ...cells.map(line)];
  if (latest === null) {
    out.push("", "latest version unknown (could not reach GitHub) — update column shows ?");
  }
  return out.join("\n");
}
