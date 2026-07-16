import { readDashboardUser } from "@librarian/mcp-server/extension";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DASHBOARD_USER_HEADER, DASHBOARD_USER_POISON } from "@/lib/dashboard-assertion";

// spec 065 SC 3 — the identity callback's FIVE-ROW table and the pinned scope discriminator.
// `next/headers` and `@/auth` are mocked here so each row is driven directly; the discriminator's
// pin against the INSTALLED next (the real E251 error) lives in trpc-server-identity-scope.test.ts.

const { cookiesMock, authMock } = vi.hoisted(() => ({
  cookiesMock: vi.fn(),
  authMock: vi.fn(),
}));
vi.mock("next/headers", () => ({ cookies: cookiesMock }));
vi.mock("@/auth", () => ({ auth: authMock }));

const { dashboardIdentityHeaders } = await import("@/lib/trpc-server");

function inScope(cookieNames: string[]): void {
  cookiesMock.mockResolvedValue({
    getAll: () => cookieNames.map((name) => ({ name, value: "v" })),
  });
}

/** An error shaped like Next's outside-request-scope throw (`cookies()` outside a request). */
function outsideScopeError(): Error {
  const error = new Error(
    "`cookies` was called outside a request scope. Read more: https://nextjs.org/docs/messages/next-dynamic-api-wrong-context",
  );
  Object.defineProperty(error, "__NEXT_ERROR_CODE", { value: "E251", enumerable: false });
  return error;
}

function decode(headers: Record<string, string>) {
  return readDashboardUser({
    headers: { [DASHBOARD_USER_HEADER]: headers[DASHBOARD_USER_HEADER] },
  });
}

beforeEach(() => {
  cookiesMock.mockReset();
  authMock.mockReset();
});

describe("dashboardIdentityHeaders — the five rows (SC 3)", () => {
  it("row 1: a request-scoped call with a resolving session carries the USER assertion", async () => {
    inScope(["authjs.session-token"]);
    authMock.mockResolvedValue({
      user: { sub: "42", provider: "github", email: "o@e.co", name: "Owner" },
    });

    const headers = await dashboardIdentityHeaders();

    expect(decode(headers)).toEqual({
      kind: "user",
      user: { provider: "github", sub: "42", email: "o@e.co", name: "Owner" },
    });
  });

  it("row 2: a session cookie present but not resolving yields the POISON marker", async () => {
    inScope(["authjs.session-token"]);
    authMock.mockResolvedValue(null); // expired / undecodable

    const headers = await dashboardIdentityHeaders();

    expect(headers[DASHBOARD_USER_HEADER]).toBe(DASHBOARD_USER_POISON);
  });

  it("row 2 regression: a CHUNKED-then-expired session cookie is detected by prefix and poisons", async () => {
    inScope(["authjs.session-token.0", "authjs.session-token.1"]);
    authMock.mockResolvedValue(null);

    const headers = await dashboardIdentityHeaders();

    expect(headers[DASHBOARD_USER_HEADER]).toBe(DASHBOARD_USER_POISON);
  });

  it("row 2: a session missing the stable subject (no provider/sub claims) poisons rather than asserting", async () => {
    inScope(["__Secure-authjs.session-token"]);
    authMock.mockResolvedValue({ user: { name: "Owner", email: "o@e.co" } }); // pre-065 session shape

    const headers = await dashboardIdentityHeaders();

    expect(headers[DASHBOARD_USER_HEADER]).toBe(DASHBOARD_USER_POISON);
  });

  it("row 3: a sessionless request-scoped call carries {anon:true} — browser-shaped, never machine trust", async () => {
    inScope(["theme", "authjs.csrf-token"]); // no session cookie

    const headers = await dashboardIdentityHeaders();

    expect(decode(headers)).toEqual({ kind: "anonymous" });
    expect(authMock).not.toHaveBeenCalled(); // nothing to resolve
  });

  it("row 4: outside a request scope the callback sends NO header and does not throw", async () => {
    cookiesMock.mockRejectedValue(outsideScopeError());

    const headers = await dashboardIdentityHeaders();

    expect(headers).toEqual({});
  });

  it("row 5: session resolution throwing inside request scope yields the POISON marker", async () => {
    inScope(["authjs.session-token"]);
    authMock.mockRejectedValue(new Error("jwt decryption failed"));

    const headers = await dashboardIdentityHeaders();

    expect(headers[DASHBOARD_USER_HEADER]).toBe(DASHBOARD_USER_POISON);
  });
});

describe("the scope discriminator is an ALLOW-LIST of one (SC 3)", () => {
  it("re-throws the prerender-bailout control-flow error (the route must become dynamic)", async () => {
    const bailout = new Error("Dynamic server usage: Route / couldn't be rendered statically");
    (bailout as Error & { digest?: string }).digest = "DYNAMIC_SERVER_USAGE";
    Object.defineProperty(bailout, "__NEXT_ERROR_CODE", { value: "E558", enumerable: false });
    cookiesMock.mockRejectedValue(bailout);

    await expect(dashboardIdentityHeaders()).rejects.toBe(bailout);
  });

  it("re-throws a static-generation bailout (never bakes admin data into anonymous HTML)", async () => {
    const bailout = new Error(
      'Page with `dynamic = "error"` couldn\'t be rendered statically because it used `cookies`',
    );
    (bailout as Error & { digest?: string }).digest = "NEXT_STATIC_GEN_BAILOUT";
    cookiesMock.mockRejectedValue(bailout);

    await expect(dashboardIdentityHeaders()).rejects.toBe(bailout);
  });

  it("re-throws an UNRECOGNISED probe throw — the unclassified remainder never defaults to machine trust", async () => {
    const unknown = new Error("something else entirely");
    cookiesMock.mockRejectedValue(unknown);

    await expect(dashboardIdentityHeaders()).rejects.toBe(unknown);
  });

  it("re-throws an error carrying a DIFFERENT __NEXT_ERROR_CODE even if the message looks similar", async () => {
    const other = new Error("`cookies` was called outside a request scope (imitation)");
    Object.defineProperty(other, "__NEXT_ERROR_CODE", { value: "E696", enumerable: false });
    cookiesMock.mockRejectedValue(other);

    await expect(dashboardIdentityHeaders()).rejects.toBe(other);
  });
});
