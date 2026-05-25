import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// D3.3: /login renders only the configured methods — a password form when a password
// method is set, and an OAuth button per configured provider.

const getAuthConfigMock = vi.fn();
vi.mock("@/auth", () => ({ signIn: vi.fn() }));
vi.mock("@/lib/auth-config-client", () => ({ getAuthConfig: () => getAuthConfigMock() }));

const { default: LoginPage } = await import("../app/login/page");

function render(config: unknown): Promise<string> {
  getAuthConfigMock.mockResolvedValueOnce(config);
  return LoginPage({ searchParams: Promise.resolve({}) }).then((el) => renderToString(el));
}

afterEach(() => getAuthConfigMock.mockReset());

describe("apps/dashboard/app/login/page.tsx", () => {
  it("shows the password form when a password method is configured", async () => {
    const html = await render({
      methods: ["password"],
      oauth: {},
      password: { username: "owner" },
    });
    expect(html).toMatch(/name="username"/);
    expect(html).toMatch(/name="password"/);
  });

  it("hides the password form when no password method is configured", async () => {
    const html = await render({ methods: ["github"], oauth: { github: { clientId: "x" } } });
    expect(html).not.toMatch(/name="password"/);
    expect(html).toMatch(/Continue with GitHub/);
  });

  it("renders an OAuth button only for each configured provider", async () => {
    const html = await render({ methods: ["google"], oauth: { google: { clientId: "x" } } });
    expect(html).toMatch(/Continue with Google/);
    expect(html).not.toMatch(/Continue with GitHub/);
  });

  it("shows nothing extra for an unconfigured store with no env providers", async () => {
    const prevGh = process.env.AUTH_GITHUB_ID;
    const prevGg = process.env.AUTH_GOOGLE_ID;
    process.env.AUTH_GITHUB_ID = "";
    process.env.AUTH_GOOGLE_ID = "";
    try {
      const html = await render({ methods: [], oauth: {} });
      expect(html).not.toMatch(/name="password"/);
      expect(html).not.toMatch(/Continue with/);
    } finally {
      process.env.AUTH_GITHUB_ID = prevGh;
      process.env.AUTH_GOOGLE_ID = prevGg;
    }
  });
});
