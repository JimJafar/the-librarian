#!/usr/bin/env node
// Naming-canon guard (plan 046 / spec 045 Vocabulary).
//
// The rename (plan 046 PR-2) settled a three-word vocabulary:
//   - "Intake"   — job 1 (the inbox sweep; was "consolidator").
//   - "Grooming" — job 2 (slice curation + the memory chat; was the
//                  grooming-sense of "curator").
//   - "Curator"  — the UMBRELLA entity that performs the two jobs. It is a
//                  legitimate namespace/symbol: the dashboard page title, the
//                  `/curator` route, the `curator.<job>.*` settings prefix, the
//                  `curator_note` field, the `Curation*` projection, and the
//                  both-job symbols (`CuratorConsumer`, `CuratorJob`, …).
//
// The HARD rule this guard protects: **no JOB is named "curator" or
// "consolidator".** A job is "intake" or "grooming". So this guard fails if:
//   (a) any `consolidator`-named *code identifier* reappears, or
//   (b) a grooming-sense `Curator*` *job symbol* that PR-2 renamed reappears
//       (e.g. runCuratorTick, CuratorConfig, writeCuratorConfig, CuratorTick*,
//       curatorChat, the dashboard CuratorConfigForm/CuratorRunsTable/… set).
//
// It deliberately does NOT blanket-ban the strings "curator"/"consolidator":
// the umbrella keepers above and the documented carve-out survivors below are
// allow-listed.
//
// ── What this guard does NOT catch (be honest) ───────────────────────────────
//   - It is a lexical scan of `packages/**` + `apps/**` `*.ts`/`*.tsx` source
//     (no dist/node_modules). It does NOT scan `.mjs`/`.js` scripts, `.json`
//     fixtures, markdown, or `docs/`. A regression there slips through.
//   - It pattern-matches FORBIDDEN job symbols by name. A brand-new
//     grooming-sense symbol with a novel spelling we didn't enumerate (say,
//     `CuratorSweepResult`) would NOT be caught — only the families below are.
//     This is the tightest *safe* mechanical guard: a blanket `Curator` ban is
//     unworkable (the umbrella set is large + legitimate), so we enumerate the
//     renamed job families instead. Extend FORBIDDEN_CURATOR_PATTERNS if a new
//     grooming-sense name is ever introduced.
//   - The `consolidator` rule is the strong one: it catches ANY occurrence of
//     the substring except the explicitly allow-listed survivor lines.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const scanRoots = ["packages", "apps"].map((d) => path.join(repoRoot, d));

// ── (a) consolidator: ANY occurrence is forbidden EXCEPT these documented
//     carve-out survivors (spec 045 D-9 + the reconciled canon). Each regex is
//     tested against the whole line; a line matching ANY of them is allowed.
const CONSOLIDATOR_SURVIVORS = [
  // The deprecated runtime env-var name + its tick (deployment contract).
  /LIBRARIAN_CONSOLIDATOR/,
  // The persisted actor-id VALUE written onto intake rows (recall may scope by
  // agent_id — flipping it would orphan provenance). String literal only.
  /"system-consolidator"/,
  // The LLM system-prompt persona ("You are the Consolidator…"). Wording is
  // behaviour: changing it changes model output. Matched loosely on the persona.
  /\bthe Consolidator\b/,
];

// ── (b) grooming-sense Curator JOB symbols that PR-2 renamed → Grooming*.
//     These are the families to fail on. Word-boundaried so they don't match
//     the umbrella keepers (CuratorConsumer, CuratorJob, CuratorNote,
//     CuratorPage, Curation*, migrateCuratorAddendum, …).
const FORBIDDEN_CURATOR_PATTERNS = [
  /\brunCuratorTick\b/,
  /\bCuratorTick(Result|Options|SkipReason|Outcome)\b/,
  /\b(read|write)CuratorConfig\b/,
  // The grooming config type + patch. The trailing \b keeps these from matching
  // the longer dashboard `CuratorConfigForm` / `CuratorConfigSummary` (no word
  // boundary after "Config" there) — those have their own patterns below.
  /\bCuratorConfig\b/,
  /\bCuratorConfigPatch(Schema)?\b/,
  /\bcuratorChat\b/,
  /\bcurator-chat\b/,
  /\bmigrateCuratorEnablement\b/,
  // Dashboard grooming-sense component/action symbols (R4 renamed → Grooming*).
  /\bCuratorConfigForm\b/,
  /\bCuratorConfigSummary\b/,
  /\bCuratorRunsTable\b/,
  /\bCuratorChatWorkspace\b/,
  /\brunCuratorNowAction\b/,
  /\bsaveCuratorConfigAction\b/,
];

const failures = [];

for (const root of scanRoots) {
  for (const file of walk(root)) {
    const rel = path.relative(repoRoot, file);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      const lineNo = i + 1;

      // (a) consolidator
      if (/consolidator/i.test(line) && !CONSOLIDATOR_SURVIVORS.some((re) => re.test(line))) {
        failures.push(`${rel}:${lineNo}  forbidden "consolidator" identifier — ${line.trim()}`);
      }

      // (b) grooming-sense curator job symbols
      for (const re of FORBIDDEN_CURATOR_PATTERNS) {
        if (re.test(line)) {
          failures.push(
            `${rel}:${lineNo}  forbidden grooming-sense curator symbol (${re}) — ${line.trim()}`,
          );
          break;
        }
      }
    });
  }
}

if (failures.length) {
  console.error("[check-naming-canon] FAIL — the curator naming canon regressed:");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    "\nNo JOB may be named 'curator' or 'consolidator' — use 'intake' or 'grooming'. " +
      "'Curator' is the umbrella only (page title, /curator route, curator.<job>.* keys, " +
      "curator_note, Curation* projection, CuratorConsumer/CuratorJob). If you added a " +
      "legitimate survivor, allow-list it in scripts/check-naming-canon.mjs with a comment.",
  );
  process.exit(1);
}

console.log(
  "[check-naming-canon] OK: no forbidden consolidator/grooming-sense-curator identifiers " +
    "under packages/** + apps/** (*.ts/*.tsx). Documented survivors allow-listed.",
);

// Walk *.ts/*.tsx under a root, skipping dist + node_modules.
function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".next") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) yield full;
  }
}
