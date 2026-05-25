import { afterEach, describe, expect, it, vi } from "vitest";

const createMock = vi.fn();
const revokeMock = vi.fn();
const revalidateMock = vi.fn();

vi.mock("@/lib/trpc-server", () => ({
  serverTRPC: {
    tokens: {
      create: { mutate: createMock },
      revoke: { mutate: revokeMock },
    },
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

const actions = await import("../app/tokens/actions");

describe("tokens actions", () => {
  afterEach(() => {
    createMock.mockReset();
    revokeMock.mockReset();
    revalidateMock.mockReset();
  });

  it("returns the one-time token and revalidates on create", async () => {
    createMock.mockResolvedValue({ id: "abc", token: "lib.abc.secret" });
    const res = await actions.createTokenAction({ agentId: "claude", label: "laptop" });
    expect(res).toEqual({ ok: true, id: "abc", token: "lib.abc.secret" });
    expect(createMock).toHaveBeenCalledWith({ agentId: "claude", label: "laptop" });
    expect(revalidateMock).toHaveBeenCalledWith("/tokens");
  });

  it("maps a create failure to an error result and does not revalidate", async () => {
    createMock.mockRejectedValue(new Error("agentId is reserved"));
    const res = await actions.createTokenAction({ agentId: "system-migration" });
    expect(res).toEqual({ ok: false, error: "agentId is reserved" });
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it("revokes by id and revalidates", async () => {
    revokeMock.mockResolvedValue({ revoked: true });
    const res = await actions.revokeTokenAction("abc");
    expect(res).toEqual({ ok: true });
    expect(revokeMock).toHaveBeenCalledWith({ id: "abc" });
    expect(revalidateMock).toHaveBeenCalledWith("/tokens");
  });
});
