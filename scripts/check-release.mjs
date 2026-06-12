#!/usr/bin/env node
// Release-hygiene guard — the "every merge to main IS a release" model.
//
// This repo has NO `## [Unreleased]` CHANGELOG section and NO separate
// "cut a release" PR. Every PR that merges to `main` bumps the root
// package.json version and files its notes under a dated
// `## [X.Y.Z] — YYYY-MM-DD` heading; the push to `main` then auto-cuts the
// git tag + GitHub release (.github/workflows/release.yml). This guard fails a
// PR that breaks that contract, so a change can't land without a version bump
// and a matching changelog entry — which is exactly how `[Unreleased]`
// sections and forgotten version bumps used to slip onto `main`.
//
// ── Checks (working-tree only, no network) ───────────────────────────────────
//   1. CHANGELOG.md has NO `## [Unreleased]` heading.
//   2. The TOP-MOST `## [X.Y.Z] — YYYY-MM-DD` heading's version === the root
//      package.json version (the release you're shipping is documented + on top).
//   3. That date is a real ISO-8601 calendar date (catches 2026-13-99 etc.).
//   4. A `[X.Y.Z]:` link-reference line exists at the bottom for that version.
//
// Plus, when the env var RELEASE_BASE_VERSION is set — CI sets it to the base
// branch's version on PR branches — the current version must be strictly
// greater (semver), i.e. the PR actually bumped it.
//
// ── What this does NOT check (be honest) ─────────────────────────────────────
//   - The *size* of the bump (PATCH vs MINOR vs MAJOR) is a human/semver call;
//     this guard only proves a bump happened, not that it's the right size.
//   - Only the root package.json is versioned. The workspace packages are
//     private and intentionally pinned at 0.0.0 — they are not inspected.
//
// Usage:
//   node scripts/check-release.mjs            # guard (exit 1 on any violation)
//   node scripts/check-release.mjs --notes    # print the top version's notes body
//                                             # (used by the Release workflow)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const changelogPath = path.join(repoRoot, "CHANGELOG.md");
const pkgPath = path.join(repoRoot, "package.json");

const pkgVersion = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
const changelog = fs.readFileSync(changelogPath, "utf8");
const lines = changelog.split("\n");

// The top-most release heading: `## [X.Y.Z] — YYYY-MM-DD` (em-dash or hyphen).
// The version core may carry a semver pre-release suffix (e.g. `1.0.0-rc.1`,
// spec 2026-06-12-rethink §15.1) — the Release workflow tags it like any other.
const VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;
const HEADING = new RegExp(String.raw`^## \[(${VERSION})\]\s*[—-]\s*(\d{4}-\d{2}-\d{2})\s*$`);
// A bare `## [X.Y.Z]` heading with no/!ISO date — reported with a clearer error.
const HEADING_LOOSE = new RegExp(String.raw`^## \[(${VERSION})\]`);

function findTopHeading() {
  for (let i = 0; i < lines.length; i++) {
    if (HEADING_LOOSE.test(lines[i])) return { line: lines[i], index: i };
  }
  return null;
}

// `--notes`: print the body between the top release heading and the next
// `## ` heading (the previous release), trimmed. No guard enforcement — the
// Release workflow runs this only after the guard has already passed in CI.
if (process.argv.includes("--notes")) {
  const top = findTopHeading();
  if (!top) {
    console.error("[check-release] no release heading found in CHANGELOG.md");
    process.exit(1);
  }
  const body = [];
  for (let i = top.index + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) break;
    body.push(lines[i]);
  }
  process.stdout.write(`${body.join("\n").trim()}\n`);
  process.exit(0);
}

const failures = [];

// (1) The `[Unreleased]` concept is gone — no section heading and no link
//     reference. Both are anchored to line-start, so prose that *mentions*
//     `[Unreleased]` (e.g. a changelog entry documenting its removal) is fine.
if (/^## \[Unreleased\]/m.test(changelog) || /^\[Unreleased\]:/m.test(changelog)) {
  failures.push(
    "CHANGELOG.md still has an `## [Unreleased]` heading or an `[Unreleased]:` link " +
      "reference. There is no Unreleased section in this model — file your notes " +
      "directly under a dated `## [X.Y.Z] — YYYY-MM-DD` heading for the version this " +
      "PR ships, and link it as `[X.Y.Z]:` at the bottom.",
  );
}

const top = findTopHeading();
if (!top) {
  failures.push("CHANGELOG.md has no `## [X.Y.Z]` release heading at all.");
} else {
  const strict = top.line.match(HEADING);
  if (!strict) {
    failures.push(
      `Top CHANGELOG heading is malformed: "${top.line.trim()}". ` +
        "Expected `## [X.Y.Z] — YYYY-MM-DD` (e.g. `## [0.6.1] — 2026-06-08`).",
    );
  } else {
    const [, headingVersion, date] = strict;

    // (2) Top heading must match package.json.
    if (headingVersion !== pkgVersion) {
      failures.push(
        `Version mismatch: package.json is ${pkgVersion} but the top CHANGELOG ` +
          `entry is [${headingVersion}]. Bump both together — the version you ship ` +
          "must be the newest CHANGELOG section.",
      );
    }

    // (3) Date must be a real calendar date (reconstruct to catch overflow).
    const d = new Date(`${date}T00:00:00Z`);
    const roundTrips = !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
    if (!roundTrips) {
      failures.push(
        `Top CHANGELOG entry has an invalid date "${date}" (expected a real YYYY-MM-DD).`,
      );
    }

    // (4) The compare-link reference for this version must exist.
    const linkRef = new RegExp(`^\\[${headingVersion.replace(/\./g, "\\.")}\\]:\\s+https?://`, "m");
    if (!linkRef.test(changelog)) {
      failures.push(
        `Missing the \`[${headingVersion}]:\` compare-link at the bottom of CHANGELOG.md. ` +
          "Add it next to the others and repoint the `[Unreleased]`-equivalent / newest link.",
      );
    }
  }
}

// (5) When CI provides the base version, prove the PR actually bumped it.
const baseVersion = (process.env.RELEASE_BASE_VERSION || "").trim();
if (baseVersion && top) {
  if (!semverGt(pkgVersion, baseVersion)) {
    failures.push(
      `Version was not bumped: this branch is ${pkgVersion} but base main is ` +
        `${baseVersion}. Every PR must raise the version (PATCH at minimum) — see docs/release.md.`,
    );
  }
}

if (failures.length) {
  console.error("[check-release] FAIL — release hygiene violated:");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    "\nThe model: every PR bumps the root package.json + files a dated " +
      "`## [X.Y.Z]` CHANGELOG entry (no `[Unreleased]`); merging to main auto-cuts " +
      "the tag + release. See docs/release.md and AGENTS.md → Releases.",
  );
  process.exit(1);
}

console.log(
  `[check-release] OK: v${pkgVersion} is the top CHANGELOG entry, dated, linked, no [Unreleased]` +
    (baseVersion ? ` (bumped from base ${baseVersion}).` : "."),
);

// Strict-greater semver compare, pre-release aware: cores compare numerically;
// on an equal core a pre-release sorts BELOW the release (1.0.0-rc.1 < 1.0.0)
// and two pre-releases compare identifier-by-identifier (semver §11), so
// promoting rc.1 → rc.2 → 1.0.0 counts as a bump. Build metadata is ignored.
function semverGt(a, b) {
  const parse = (v) => {
    const [core, ...pre] = v.split("+")[0].split("-");
    return { core: core.split(".").map(Number), pre: pre.join("-") };
  };
  const A = parse(a);
  const B = parse(b);
  for (let i = 0; i < 3; i++) {
    if (A.core[i] !== B.core[i]) return A.core[i] > B.core[i];
  }
  if (!A.pre && !B.pre) return false; // identical cores, no pre-release
  if (!A.pre) return true; // release > its pre-releases
  if (!B.pre) return false; // pre-release < the release
  const as = A.pre.split(".");
  const bs = B.pre.split(".");
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return false; // shorter pre-release sorts first
    if (y === undefined) return true;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) > Number(y);
    if (xn !== yn) return yn; // numeric identifiers sort below alphanumeric
    return x > y;
  }
  return false;
}
