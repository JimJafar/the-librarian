import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getAuthConfigMock = vi.fn();
const getTokenMock = vi.fn();

vi.mock("@/lib/auth-config-client", () => ({
  getAuthConfigSafe: () => getAuthConfigMock(),
}));
vi.mock("next-auth/jwt", () => ({
  getToken: (...args: unknown[]) => getTokenMock(...args),
}));

const { config, default: middleware } = await import("@/middleware");

const pendingConfig = {
  enabled: false,
  methods: [],
  password: null,
  oauth: {},
  ownerOAuth: {},
  authSecret: "derived-auth-secret",
  claimPending: true,
};

beforeEach(() => {
  getAuthConfigMock.mockReset();
  getTokenMock.mockReset();
  delete process.env.LIBRARIAN_AUTH_ENABLED;
});

afterEach(() => {
  delete process.env.LIBRARIAN_AUTH_ENABLED;
});

describe("bootstrap claim middleware routing", () => {
  it.each(["/", "/settings/auth"])(
    "redirects %s to /claim while first-owner claim is pending",
    async (pathname) => {
      getAuthConfigMock.mockResolvedValue(pendingConfig);

      const response = await middleware(new NextRequest(`https://library.example${pathname}`));

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe("https://library.example/claim");
      expect(getTokenMock).not.toHaveBeenCalled();
    },
  );

  it("lets claim pending outrank the legacy env enforcement floor", async () => {
    process.env.LIBRARIAN_AUTH_ENABLED = "true";
    getAuthConfigMock.mockResolvedValue(pendingConfig);

    const response = await middleware(new NextRequest("https://library.example/memories"));

    expect(response.headers.get("location")).toBe("https://library.example/claim");
    expect(getTokenMock).not.toHaveBeenCalled();
  });

  it("still blocks before making any claim decision when the store is unreachable", async () => {
    getAuthConfigMock.mockResolvedValue(null);

    const response = await middleware(new NextRequest("https://library.example/"));

    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
  });

  it("excludes /claim itself from the matcher so the redirect cannot loop", () => {
    expect(config.matcher[0]).toContain("claim(?:/|$)");
  });
});
