// The backup remote URL is built as `…/${repo}.git`, so `backup.github.repo` must
// be a bare "owner/repo" slug. These tests pin the canonical shape rule + the
// teaching error (which echoes the offending value, never a token) so the gate at
// the tRPC config boundary stays honest.

import { githubRepoSlugError, isValidGithubRepoSlug } from "@librarian/core";
import { describe, expect, it } from "vitest";

describe("isValidGithubRepoSlug", () => {
  it("accepts a bare owner/repo slug, including dots, dashes and underscores", () => {
    expect(isValidGithubRepoSlug("octocat/hello-world")).toBe(true);
    expect(isValidGithubRepoSlug("me/backups")).toBe(true);
    expect(isValidGithubRepoSlug("My_Org/my.repo-1")).toBe(true);
  });

  it("rejects a lone name, a full URL, and other junk that breaks the push", () => {
    expect(isValidGithubRepoSlug("hello-world")).toBe(false);
    expect(isValidGithubRepoSlug("https://github.com/me/backups.git")).toBe(false);
    expect(isValidGithubRepoSlug("me/backups.git extra")).toBe(false);
    expect(isValidGithubRepoSlug("a/b/c")).toBe(false);
    expect(isValidGithubRepoSlug("")).toBe(false);
  });
});

describe("githubRepoSlugError", () => {
  it("teaches the expected shape and echoes the offending value verbatim", () => {
    const msg = githubRepoSlugError("hello-world");
    expect(msg).toContain('Expected "owner/repo"');
    expect(msg).toContain("octocat/hello-world");
    expect(msg).toContain("hello-world");
  });
});
