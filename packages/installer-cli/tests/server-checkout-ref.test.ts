// Regression (real git, no mock): `git checkout --end-of-options <ref>` is
// REJECTED by real git — `checkout` reads the `--end-of-options` marker as a
// pathspec (`error: pathspec '--end-of-options' did not match`, verified on git
// 2.43), which broke `server up`/`update` at the checkout step. The other tests
// in this package inject a FakeRunner and only assert argv, so they CANNOT catch
// this — by construction they never run real git. This test drives `checkoutRef`
// against a throwaway LOCAL git repo (no network, no daemon) so the real binary
// validates the fix: resolve the ref to a SHA via `rev-parse` (which DOES honor
// `--end-of-options`, keeping the S-1 injection guard), then check out the SHA.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetRunner } from "../src/server/docker.js";
import { checkoutRef } from "../src/server/up.js";

/** Run a git command in `dir`, returning trimmed stdout. */
function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

/** A throwaway repo with one commit and a tag; returns its dir + tag commit SHA. */
function makeRepo(): { dir: string; tagSha: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-checkout-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "file.txt"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "tag", "v0.0.0-test");
  return { dir, tagSha: git(dir, "rev-parse", "v0.0.0-test^{commit}") };
}

describe("checkoutRef (real git, local repo)", () => {
  // The other suites inject a fake runner; ensure checkoutRef uses REAL git here.
  afterEach(() => resetRunner());

  it("checks out a tag by resolving it to a commit SHA", async () => {
    resetRunner();
    const { dir, tagSha } = makeRepo();
    try {
      // Make HEAD differ from the tag first, so a no-op can't masquerade as success.
      fs.writeFileSync(path.join(dir, "file.txt"), "changed\n");
      git(dir, "commit", "-aqm", "second");
      expect(git(dir, "rev-parse", "HEAD")).not.toBe(tagSha);

      await checkoutRef(dir, "v0.0.0-test");

      expect(git(dir, "rev-parse", "HEAD")).toBe(tagSha);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an option-shaped ref instead of executing it (S-1 guard)", async () => {
    resetRunner();
    const { dir } = makeRepo();
    try {
      // `--end-of-options` makes rev-parse treat this as a (bogus) revision, not
      // an option — so it fails to resolve and checkoutRef throws, never running
      // it as a git flag.
      await expect(checkoutRef(dir, "--upload-pack=touch /tmp/pwned")).rejects.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
