import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("bootstrap claim deployment wiring", () => {
  it("passes the documented Compose arming secret to the MCP server", () => {
    const exampleEnv = read(".env.example");
    const compose = read("docker/docker-compose.yml");

    expect(exampleEnv).toContain("LIBRARIAN_BOOTSTRAP_CLAIM_SECRET=");
    expect(compose).toContain(
      'LIBRARIAN_BOOTSTRAP_CLAIM_SECRET: "${LIBRARIAN_BOOTSTRAP_CLAIM_SECRET:-}"',
    );
  });
});
