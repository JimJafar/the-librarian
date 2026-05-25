import { afterEach, describe, expect, it, vi } from "vitest";

// D5.1: the auth setup-wizard server actions call the right admin procedures and
// bust the auth-config cache so changes take effect immediately.

const enableMock = vi.fn();
const disableMock = vi.fn();
const setPasswordMock = vi.fn();
const configureOAuthMock = vi.fn();
const setOwnerMock = vi.fn();
const bustMock = vi.fn();
const revalidateMock = vi.fn();

vi.mock("@/lib/trpc-server", () => ({
  serverTRPC: {
    auth: {
      enable: { mutate: enableMock },
      disable: { mutate: disableMock },
      setPassword: { mutate: setPasswordMock },
      configureOAuth: { mutate: configureOAuthMock },
      setOwner: { mutate: setOwnerMock },
    },
  },
}));
vi.mock("@/lib/auth-config-client", () => ({ bustAuthConfig: bustMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

const actions = await import("../app/settings/auth/actions");

afterEach(() => {
  for (const m of [
    enableMock,
    disableMock,
    setPasswordMock,
    configureOAuthMock,
    setOwnerMock,
    bustMock,
    revalidateMock,
  ]) {
    m.mockReset();
  }
});

describe("settings/auth actions", () => {
  it("enable calls auth.enable with the admin token, then busts + revalidates", async () => {
    enableMock.mockResolvedValue({ enabled: true });
    const res = await actions.enableAuthAction("libadmin_token");
    expect(res).toEqual({ ok: true });
    expect(enableMock).toHaveBeenCalledWith({ adminToken: "libadmin_token" });
    expect(bustMock).toHaveBeenCalledTimes(1);
    expect(revalidateMock).toHaveBeenCalledWith("/settings/auth");
  });

  it("setPassword / configureOAuth / setOwner / disable call their procedures and bust", async () => {
    setPasswordMock.mockResolvedValue({ ok: true });
    await actions.setPasswordAction({ username: "owner", password: "a-strong-passphrase" });
    expect(setPasswordMock).toHaveBeenCalledWith({
      username: "owner",
      password: "a-strong-passphrase",
    });

    configureOAuthMock.mockResolvedValue({ ok: true });
    await actions.configureOAuthAction({ provider: "github", clientId: "id", clientSecret: "sec" });
    expect(configureOAuthMock).toHaveBeenCalledWith({
      provider: "github",
      clientId: "id",
      clientSecret: "sec",
    });

    setOwnerMock.mockResolvedValue({ ok: true });
    await actions.setOwnerAction({ provider: "github", ownerId: "octocat" });
    expect(setOwnerMock).toHaveBeenCalledWith({ provider: "github", ownerId: "octocat" });

    disableMock.mockResolvedValue({ enabled: false });
    await actions.disableAuthAction();
    expect(disableMock).toHaveBeenCalledTimes(1);

    expect(bustMock).toHaveBeenCalledTimes(4);
  });

  it("maps a mutation failure to an error result without busting", async () => {
    enableMock.mockRejectedValue(new Error("admin token does not match"));
    const res = await actions.enableAuthAction("wrong");
    expect(res).toEqual({ ok: false, error: "admin token does not match" });
    expect(bustMock).not.toHaveBeenCalled();
    expect(revalidateMock).not.toHaveBeenCalled();
  });
});
