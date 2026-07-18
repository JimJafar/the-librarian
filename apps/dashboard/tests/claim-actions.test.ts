import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const redeemMock = vi.fn();
const bustMock = vi.fn();
const signInMock = vi.fn();
const redirectMock = vi.fn();
const headersMock = vi.fn();

vi.mock("@/lib/trpc-server-bare", () => ({
  bareServerTRPC: { auth: { redeemBootstrapClaim: { mutate: redeemMock } } },
}));
vi.mock("@/lib/auth-config-client", () => ({ bustAuthConfig: bustMock }));
vi.mock("@/auth", () => ({ signIn: signInMock }));
vi.mock("next/navigation", () => ({ redirect: redirectMock }));
vi.mock("next/headers", () => ({ headers: headersMock }));

const priorLimit = process.env.LIBRARIAN_CLAIM_RATE_LIMIT;
process.env.LIBRARIAN_CLAIM_RATE_LIMIT = "2";
const { redeemClaimAction } = await import("@/app/claim/actions");
const { POST: redeemClaimRoute } = await import("@/app/api/claim/redeem/route");

const INITIAL = { status: "idle" } as const;
const PASSWORD = "correct-horse-battery";
const GENERIC_REFUSAL = "claim invalid, already used, or not armed";
let ipSequence = 10;

function form(overrides: Record<string, string> = {}): FormData {
  const data = new FormData();
  data.set("token", overrides.token ?? "v1.claim.mac");
  data.set("password", overrides.password ?? PASSWORD);
  data.set("confirm", overrides.confirm ?? PASSWORD);
  return data;
}

function success(overrides: Record<string, string | null> = {}) {
  return {
    ok: true,
    email: overrides.email ?? "owner@example.com",
    returnTo: overrides.returnTo ?? null,
    receipt: overrides.receipt ?? "claim-receipt",
    claimedAt: "2026-07-18T12:00:00.000Z",
  };
}

beforeEach(() => {
  redeemMock.mockReset();
  bustMock.mockReset();
  signInMock.mockReset();
  redirectMock.mockReset();
  headersMock.mockReset();
  ipSequence += 1;
  headersMock.mockResolvedValue(new Headers({ "x-forwarded-for": `203.0.113.${ipSequence}` }));
});

afterAll(() => {
  if (priorLimit === undefined) delete process.env.LIBRARIAN_CLAIM_RATE_LIMIT;
  else process.env.LIBRARIAN_CLAIM_RATE_LIMIT = priorLimit;
});

describe("bootstrap claim server action", () => {
  it("redeems, busts auth config, signs in with the verified email, and lands on /", async () => {
    redeemMock.mockResolvedValue(success());
    signInMock.mockResolvedValue("/");

    await redeemClaimAction(INITIAL, form());

    expect(redeemMock).toHaveBeenCalledWith({
      token: "v1.claim.mac",
      password: PASSWORD,
    });
    expect(bustMock).toHaveBeenCalledOnce();
    expect(signInMock).toHaveBeenCalledWith("credentials", {
      username: "owner@example.com",
      password: PASSWORD,
      redirect: false,
      redirectTo: "/",
    });
    expect(redirectMock).toHaveBeenCalledWith("/");
  });

  it("uses only the verified returnTo and appends the receipt without clobbering its query", async () => {
    redeemMock.mockResolvedValue(
      success({
        returnTo: "https://console.example.test/claimed?tenant=tenant-1",
        receipt: "signed-receipt",
      }),
    );
    signInMock.mockResolvedValue("/");

    await redeemClaimAction(INITIAL, form());

    const destination = new URL(String(redirectMock.mock.calls[0]?.[0]));
    expect(destination.origin + destination.pathname).toBe("https://console.example.test/claimed");
    expect(destination.searchParams.get("tenant")).toBe("tenant-1");
    expect(destination.searchParams.get("claim_receipt")).toBe("signed-receipt");
  });

  it("falls back to a success state and /login when Auth.js cannot establish the session", async () => {
    redeemMock.mockResolvedValue(
      success({
        returnTo: "https://console.example.test/claimed",
        receipt: "signed-receipt",
      }),
    );
    signInMock.mockResolvedValue("/login?error=CredentialsSignin");

    const result = await redeemClaimAction(INITIAL, form());

    expect(result).toEqual({
      status: "claimed",
      loginHref: "/login",
      continueUrl: "https://console.example.test/claimed?claim_receipt=signed-receipt",
    });
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("does not mistake Auth.js's sign-in form URL for an established session", async () => {
    redeemMock.mockResolvedValue(success());
    signInMock.mockResolvedValue("/api/auth/signin?callbackUrl=%2F");

    await expect(redeemClaimAction(INITIAL, form())).resolves.toEqual({
      status: "claimed",
      loginHref: "/login",
      continueUrl: null,
    });
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("surfaces only the claim procedure's disclosed error messages", async () => {
    redeemMock.mockRejectedValueOnce(new Error("claim expired"));
    await expect(redeemClaimAction(INITIAL, form())).resolves.toEqual({
      status: "error",
      error: "claim expired",
    });

    redeemMock.mockRejectedValueOnce(new Error("connect ECONNREFUSED with internal detail"));
    await expect(redeemClaimAction(INITIAL, form())).resolves.toEqual({
      status: "error",
      error: "claim invalid, already used, or not armed",
    });
    expect(bustMock).not.toHaveBeenCalled();
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("ignores a non-HTTPS returnTo even though it came from a verified claim", async () => {
    redeemMock.mockResolvedValue(success({ returnTo: "http://console.example.test/claimed" }));
    signInMock.mockResolvedValue("/");

    await redeemClaimAction(INITIAL, form());

    expect(redirectMock).toHaveBeenCalledWith("/");
  });

  it("rejects mismatched confirmation before sending the claim credential upstream", async () => {
    const result = await redeemClaimAction(INITIAL, form({ confirm: "different-passphrase" }));

    expect(result).toEqual({ status: "error", error: "Passwords do not match." });
    expect(redeemMock).not.toHaveBeenCalled();
  });

  it("falls back cleanly when Auth.js throws instead of returning an error URL", async () => {
    redeemMock.mockResolvedValue(success());
    signInMock.mockRejectedValue(new Error("auth runtime unavailable"));

    await expect(redeemClaimAction(INITIAL, form())).resolves.toEqual({
      status: "claimed",
      loginHref: "/login",
      continueUrl: null,
    });
    expect(bustMock).toHaveBeenCalledOnce();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("rate-limits repeated attempts by the edge-supplied client key", async () => {
    headersMock.mockResolvedValue(new Headers({ "x-forwarded-for": "198.51.100.20, 10.0.0.1" }));
    redeemMock.mockRejectedValue(new Error(GENERIC_REFUSAL));

    await redeemClaimAction(INITIAL, form());
    await redeemClaimAction(INITIAL, form());
    const refused = await redeemClaimRoute(
      new Request("http://dashboard.local/api/claim/redeem", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "198.51.100.20, 10.0.0.1",
        },
        body: JSON.stringify({
          token: "v1.claim.mac",
          password: PASSWORD,
          confirm: PASSWORD,
        }),
      }),
    );

    expect(refused.status).toBe(429);
    await expect(refused.json()).resolves.toEqual({
      status: "error",
      error: "Too many claim attempts. Please wait and request a fresh link.",
      httpStatus: 429,
    });
    expect(redeemMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an oversized claim route body before parsing or redemption", async () => {
    const response = await redeemClaimRoute(
      new Request("http://dashboard.local/api/claim/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "x".repeat(70_000), password: PASSWORD, confirm: PASSWORD }),
      }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      status: "error",
      error: GENERIC_REFUSAL,
    });
    expect(redeemMock).not.toHaveBeenCalled();
  });
});
