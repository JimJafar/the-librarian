import { readDashboardUser } from "@librarian/mcp-server/extension";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DASHBOARD_USER_HEADER } from "@/lib/dashboard-assertion";

// spec 065 SC 3 — the COLD-CACHE NO-STALL regression (the two-client split's reason to exist).
//
// The circularity this pins against (spec 065 §7 pass 1, blocking): the identity callback calls
// `auth()`; `auth()`'s lazy config calls the auth-config fetch. If that fetch rode the SAME
// identity-bearing client, the callback would await the very in-flight config promise it is
// blocking — a deadlock on every cold cache, degrading to an abort and a headerless (⇒ machine
// trust) request. The fix is the bare bootstrap client. This test wires `auth()` to depend on the
// REAL auth-config-client (real cache, real client modules; only the network is mocked) and
// proves a cold-cache identity-bearing query COMPLETES and CARRIES the assertion. If anyone
// rewires the config fetch onto the identity client, the query deadlocks and the race below trips.

const { cookiesMock, authMock } = vi.hoisted(() => ({
  cookiesMock: vi.fn(),
  authMock: vi.fn(),
}));
vi.mock("next/headers", () => ({ cookies: cookiesMock }));
vi.mock("@/auth", () => ({ auth: authMock }));

interface SeenCall {
  url: string;
  assertion: string | null;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  delete process.env.LIBRARIAN_TRPC_URL;
});

describe("cold config cache + member session (SC 3 re-entrancy regression)", () => {
  it("an identity-bearing query completes without a stall and carries the user assertion; the config fetch rides bare", async () => {
    process.env.LIBRARIAN_TRPC_URL = "http://mcp-server-under-test:3840";
    vi.resetModules();

    const seen: SeenCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | URL | string, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
        seen.push({ url, assertion: headers.get(DASHBOARD_USER_HEADER) });
        const data = url.includes("auth.config")
          ? { enabled: false, methods: [], authSecret: "test-secret" }
          : { ok: true };
        return new Response(JSON.stringify([{ result: { data } }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    // A request-scoped call with a member session cookie.
    cookiesMock.mockResolvedValue({
      getAll: () => [{ name: "authjs.session-token", value: "v" }],
    });
    // auth() depends on the COLD config cache resolving first — exactly the production shape
    // (NextAuth's lazy config awaits getAuthConfigSafe on every auth() call).
    authMock.mockImplementation(async () => {
      const { getAuthConfig } = await import("@/lib/auth-config-client");
      await getAuthConfig(); // cold cache: this fetch MUST complete for auth() to resolve
      return { user: { sub: "42", provider: "github", name: "Member" } };
    });

    const { serverTRPC } = await import("@/lib/trpc-server");

    // The stall guard: a circular await would hang forever; 5s is far beyond the mocked I/O.
    const outcome = await Promise.race([
      serverTRPC.health.ping.query().then(() => "completed" as const),
      new Promise<"stalled">((resolve) => setTimeout(() => resolve("stalled"), 5000)),
    ]);
    expect(outcome).toBe("completed");

    // The config fetch rode the BARE client: no identity assertion on it.
    const configCalls = seen.filter((c) => c.url.includes("auth.config"));
    expect(configCalls.length).toBeGreaterThan(0);
    for (const call of configCalls) expect(call.assertion).toBeNull();

    // The identity-bearing query carried the USER assertion.
    const pingCalls = seen.filter((c) => c.url.includes("health.ping"));
    expect(pingCalls).toHaveLength(1);
    const assertion = readDashboardUser({
      headers: { [DASHBOARD_USER_HEADER]: pingCalls[0]!.assertion ?? undefined },
    });
    expect(assertion).toEqual({
      kind: "user",
      user: { provider: "github", sub: "42", name: "Member" },
    });
  }, 15000);
});
