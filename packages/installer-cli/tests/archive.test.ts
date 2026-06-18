// Portable codeload-subtree extraction (src/archive.ts).
//
// Regression for the GNU-only `tar --wildcards` bug: the Codex/OpenCode/Hermes
// capture-adapter fetchers selected members with
//   tar --strip-components=N --wildcards '*/integrations/<h>/*'
// which BSD/libarchive tar (macOS `/usr/bin/tar`) rejects outright
//   tar: Option --wildcards is not supported
// so `librarian install` failed every harness that fetched its adapter on a
// non-GNU box. The fix extracts the whole archive with only `-xzf`/`-C` and
// locates the subtree via the filesystem.
//
// Two layers of coverage:
//   1. integration — round-trip a real codeload-shaped tarball through the host
//      `tar` (GNU here, BSD on a contributor's mac) and assert the subtree lands.
//   2. portability guard — assert the tar invocation carries NONE of the
//      GNU-only flags. This one fails against the old code on EVERY platform,
//      including the GNU-tar CI where the integration test alone would pass.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractAdapterSubtree } from "../src/archive.js";
import { resetRunner, run, setRunner } from "../src/exec.js";
import type { RunOptions, RunResult, Runner } from "../src/exec.js";

const TOP = "the-librarian-1.0.0-rc.99"; // codeload strips the leading `v` from the tag
const tmpDirs: string[] = [];

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** Build a codeload-shaped `.tar.gz` (single top dir) with the REAL `tar`. */
async function makeCodeloadTarball(): Promise<string> {
  const stage = tmp("librarian-archive-stage-");
  const repo = path.join(stage, TOP);
  fs.mkdirSync(path.join(repo, "integrations", "codex", "scripts", "lib"), { recursive: true });
  fs.mkdirSync(path.join(repo, "integrations", "codex", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(repo, "integrations", "hermes", "librarian"), { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# repo root, NOT part of any subtree\n");
  fs.writeFileSync(
    path.join(repo, "integrations", "codex", "scripts", "on-stop.mjs"),
    "// entry\n",
  );
  fs.writeFileSync(path.join(repo, "integrations", "codex", "hooks", "codex-hooks.json"), "{}\n");
  fs.writeFileSync(
    path.join(repo, "integrations", "hermes", "librarian", "plugin.yaml"),
    "name: x\n",
  );

  const tarball = path.join(stage, "src.tar.gz");
  resetRunner(); // use the real, process-spawning runner
  const res = await run("tar", ["-czf", tarball, "-C", stage, TOP]);
  expect(res.code, `tar -czf failed: ${res.stderr}`).toBe(0);
  return tarball;
}

afterEach(() => {
  resetRunner();
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

describe("extractAdapterSubtree — real tar round-trip", () => {
  it("returns the subtree's CONTENTS, not the repo root or the subtree dir", async () => {
    const tarball = await makeCodeloadTarball();
    const out = await extractAdapterSubtree(
      tarball,
      tmp("librarian-archive-out-"),
      "integrations/codex",
    );

    // Strip semantics: the returned dir IS `integrations/codex`, so its
    // immediate children are that subtree's children — and the repo-root
    // README is nowhere underneath it.
    expect(fs.readdirSync(out).sort()).toEqual(["hooks", "scripts"]);
    expect(fs.existsSync(path.join(out, "scripts", "on-stop.mjs"))).toBe(true);
    expect(fs.existsSync(path.join(out, "scripts", "lib"))).toBe(true);
    expect(fs.readFileSync(path.join(out, "hooks", "codex-hooks.json"), "utf8")).toBe("{}\n");
    expect(fs.existsSync(path.join(out, "README.md"))).toBe(false);
  });

  it("handles a deeper subtree (Hermes' integrations/hermes/librarian)", async () => {
    const tarball = await makeCodeloadTarball();
    const out = await extractAdapterSubtree(
      tarball,
      tmp("librarian-archive-out-"),
      "integrations/hermes/librarian",
    );
    expect(fs.readFileSync(path.join(out, "plugin.yaml"), "utf8")).toBe("name: x\n");
  });

  it("throws a clear error when the requested subtree is absent", async () => {
    const tarball = await makeCodeloadTarball();
    await expect(
      extractAdapterSubtree(tarball, tmp("librarian-archive-out-"), "integrations/nope"),
    ).rejects.toThrow(/integrations\/nope.*not found/);
  });
});

// A runner that records the tar invocation and fabricates the extraction it
// implies (so the fs-discovery half of the helper still runs) — without
// spawning anything. Lets us pin the EXACT flags on any platform.
class ExtractFakeRunner implements Runner {
  readonly calls: { cmd: string; args: string[] }[] = [];
  // extra non-dot top-level siblings to drop alongside the repo dir (exercises
  // the "more than one entry → pick the-librarian-*" discovery branch)
  constructor(private readonly siblings: string[] = []) {}

  async run(cmd: string, args: readonly string[], _opts?: RunOptions): Promise<RunResult> {
    this.calls.push({ cmd, args: [...args] });
    const dashC = args.indexOf("-C");
    if (cmd === "tar" && dashC !== -1) {
      const dest = args[dashC + 1] as string;
      fs.mkdirSync(path.join(dest, TOP, "integrations", "codex", "scripts"), { recursive: true });
      fs.writeFileSync(
        path.join(dest, TOP, "integrations", "codex", "scripts", "on-stop.mjs"),
        "x",
      );
      for (const s of this.siblings) fs.mkdirSync(path.join(dest, s), { recursive: true });
    }
    return { stdout: "", stderr: "", code: 0 };
  }
  async which(): Promise<string | null> {
    return null;
  }
}

describe("extractAdapterSubtree — portability guard (flags)", () => {
  it("invokes tar with ONLY universally-supported flags — no --wildcards, no --strip-components", async () => {
    const fake = new ExtractFakeRunner();
    setRunner(fake);
    await extractAdapterSubtree(
      tmp("librarian-archive-out-") + "/src.tar.gz",
      tmp("librarian-archive-out-"),
      "integrations/codex",
    );

    const tarCalls = fake.calls.filter((c) => c.cmd === "tar");
    expect(tarCalls).toHaveLength(1);
    const args = tarCalls[0].args;
    expect(args).toContain("-xzf");
    expect(args).toContain("-C");
    // The bug, and the flags that caused it:
    expect(args).not.toContain("--wildcards");
    expect(args.some((a) => a.startsWith("--strip-components"))).toBe(false);
    // No member-glob pattern is passed to tar at all (we select via the fs).
    expect(args.some((a) => a.includes("*/integrations/"))).toBe(false);
  });

  it("discovers the repo dir even when sibling top-level entries exist", async () => {
    const fake = new ExtractFakeRunner(["pax_global_header_junk", "ignored-dir"]);
    setRunner(fake);
    const out = await extractAdapterSubtree(
      tmp("librarian-archive-out-") + "/src.tar.gz",
      tmp("librarian-archive-out-"),
      "integrations/codex",
    );
    expect(fs.existsSync(path.join(out, "scripts", "on-stop.mjs"))).toBe(true);
  });

  it("wraps a non-zero tar exit in the error (stderr surfaced)", async () => {
    setRunner({
      async run() {
        return { stdout: "", stderr: "tar: Option --wildcards is not supported", code: 1 };
      },
      async which() {
        return null;
      },
    });
    await expect(
      extractAdapterSubtree(
        "/nope/src.tar.gz",
        tmp("librarian-archive-out-"),
        "integrations/codex",
      ),
    ).rejects.toThrow(/Option --wildcards is not supported/);
  });
});
