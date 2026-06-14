// Regression guard for the backup-breaking TLS bug: `git` was installed with
// `--no-install-recommends` on a slim base that ships no CA bundle, so
// `git push https://…github.com…` (the vault backup) failed with
// "server certificate verification failed. CAfile: none CRLfile: none".
//
// `ca-certificates` is a *recommended* (not hard) dependency of git, so
// `--no-install-recommends` drops it. Both git-using images must install it in
// the SAME apt-get line as git, or backup silently breaks at runtime. A real
// `docker build` + push is slow and needs network/auth, so this is a fast static
// guard on the Dockerfile contract (the build+smoke CI job exercises it for real).

import fs from "node:fs";
import { describe, expect, it } from "vitest";

/** The apt-get install invocation (up to the next `&&`), whitespace-flattened. */
function aptInstall(relPathFromTests: string): string {
  const text = fs.readFileSync(new URL(relPathFromTests, import.meta.url), "utf8");
  const flat = text.replace(/\\\n/g, " ").replace(/[ \t]+/g, " ");
  return flat.match(/apt-get install[^&]*/)?.[0] ?? "";
}

describe.each([
  ["all-in-one.Dockerfile", "../../../docker/all-in-one.Dockerfile"],
  ["mcp-server.Dockerfile", "../../../docker/mcp-server.Dockerfile"],
])("%s installs a CA bundle so git can verify TLS (backup push)", (_name, rel) => {
  const install = aptInstall(rel);

  it("installs git", () => {
    expect(install).toMatch(/\bgit\b/);
  });

  it("installs ca-certificates in the same apt-get line as git", () => {
    // Same line => the CA bundle is present whenever git is, so a slim base's
    // missing /etc/ssl/certs/ca-certificates.crt can't break `git push https`.
    expect(install).toMatch(/\bca-certificates\b/);
  });
});
