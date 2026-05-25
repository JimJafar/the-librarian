// D3.4: configure the e2e store's auth methods once, before any spec runs, so the
// /login page renders a realistic configured deploy (password + both OAuth providers)
// and the password spec has something to sign in against. Enforcement is left OFF
// (we don't call enable) so the other specs keep running without a session — the
// shared dashboard never redirects. Talks straight to the mcp-server admin tRPC.

const SERVER_URL = process.env.LIBRARIAN_E2E_SERVER_URL ?? "http://127.0.0.1:3838";
const ADMIN_TOKEN = process.env.LIBRARIAN_E2E_ADMIN_TOKEN ?? "e2e-admin-token";

export const E2E_OWNER = "e2e-owner";
export const E2E_PASSWORD = "e2e-correct-password";

async function mutate(procedure: string, input: unknown): Promise<void> {
  const res = await fetch(`${SERVER_URL}/trpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(`e2e setup ${procedure} failed: ${res.status} ${await res.text()}`);
  }
}

export default async function globalSetup(): Promise<void> {
  await mutate("auth.setPassword", { username: E2E_OWNER, password: E2E_PASSWORD });
  await mutate("auth.configureOAuth", {
    provider: "github",
    clientId: "e2e-github-id",
    clientSecret: "e2e-github-secret",
  });
  await mutate("auth.configureOAuth", {
    provider: "google",
    clientId: "e2e-google-id",
    clientSecret: "e2e-google-secret",
  });
  await mutate("auth.setOwner", { provider: "github", ownerId: "e2e-github-owner" });
}
