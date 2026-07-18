import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("single-port deployment wiring", () => {
  it("documents the opt-in flag and public URL in the example environment", () => {
    const exampleEnv = read(".env.example");

    expect(exampleEnv).toContain("LIBRARIAN_SINGLE_PORT=false");
    expect(exampleEnv).toContain("LIBRARIAN_PUBLIC_URL=");
    expect(exampleEnv).toContain("chrome-extension://<extension-id>");
  });

  it("passes dashboard-owned single-port settings through Compose", () => {
    const compose = read("docker/docker-compose.yml");

    expect(compose).toContain('LIBRARIAN_SINGLE_PORT: "${LIBRARIAN_SINGLE_PORT:-}"');
    expect(compose).toContain('LIBRARIAN_PUBLIC_URL: "${LIBRARIAN_PUBLIC_URL:-}"');
  });

  it("enables the clean public URL in the Fly starter while retaining the migration port", () => {
    const fly = read("fly.toml");

    expect(fly).toContain('LIBRARIAN_SINGLE_PORT = "true"');
    expect(fly).toContain('LIBRARIAN_PUBLIC_URL = "https://the-librarian.fly.dev"');
    expect(fly).toContain("[[services]]");
    expect(fly).not.toContain("3838 also serves the admin tRPC API");
  });

  it("documents all five same-origin endpoints and the complete origin allow-list", () => {
    const manualInstall = read("apps/docs/src/content/docs/deploy-and-operate/manual-install.md");

    for (const route of ["/mcp", "/healthz", "/primer.md", "/transcript", "/ingest"]) {
      expect(manualInstall).toContain(`\`${route}\``);
    }

    expect(manualInstall).toContain("LIBRARIAN_SINGLE_PORT=true");
    expect(manualInstall).toContain("LIBRARIAN_PUBLIC_URL=https://memory.example.com");
    expect(manualInstall).toContain("https://memory.example.com,chrome-extension://<extension-id>");
  });
});
