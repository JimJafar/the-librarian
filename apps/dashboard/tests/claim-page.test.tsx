import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const getAuthConfigMock = vi.fn();
vi.mock("@/lib/auth-config-client", () => ({
  getAuthConfigSafe: () => getAuthConfigMock(),
}));
vi.mock("@/components/claim/claim-form", () => ({
  ClaimForm: ({ email }: { email: string }) => <div data-testid="claim-form">{email}</div>,
}));

const { default: ClaimPage } = await import("@/app/claim/page");

function token(email = "owner@example.com"): string {
  const payload = Buffer.from(
    JSON.stringify({ v: 1, purpose: "bootstrap-claim", email, exp: 1 }),
  ).toString("base64url");
  return `v1.${payload}.display-only-mac`;
}

async function render(config: unknown, claimToken?: string): Promise<string> {
  getAuthConfigMock.mockResolvedValueOnce(config);
  const element = await ClaimPage({
    searchParams: Promise.resolve(claimToken === undefined ? {} : { token: claimToken }),
  });
  return renderToString(element);
}

afterEach(() => getAuthConfigMock.mockReset());

describe("/claim page", () => {
  it("renders the verified-token email prefill only while claiming is pending", async () => {
    const html = await render({ claimPending: true }, token("owner@example.com"));

    expect(html).toContain("Claim this Librarian");
    expect(html).toContain('data-testid="claim-form"');
    expect(html).toContain("owner@example.com");
    expect(html.match(/<h1/g)).toHaveLength(1);
  });

  it("renders the dormant not-armed state when no claim is pending", async () => {
    const html = await render({ claimPending: false }, token());

    expect(html).toContain("Claiming is not available");
    expect(html).not.toContain('data-testid="claim-form"');
  });

  it("fails soft with a retry when auth config cannot be reached", async () => {
    const html = await render(null, token());

    expect(html).toContain("Claim status is unavailable");
    expect(html).toContain('href="/claim"');
    expect(html).not.toContain('data-testid="claim-form"');
  });

  it.each([undefined, "not-a-token"])(
    "teaches the claimant to request a fresh link when the token is absent or malformed",
    async (claimToken) => {
      const html = await render({ claimPending: true }, claimToken);

      expect(html).toContain("This claim link is missing or malformed");
      expect(html).not.toContain('data-testid="claim-form"');
    },
  );
});
