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

const actions = await import("../app/settings/connect/actions");

describe("connect (capture token) actions", () => {
  afterEach(() => {
    createMock.mockReset();
    revokeMock.mockReset();
    revalidateMock.mockReset();
  });

  it("mints a CAPTURE-scoped token, using the device name as label + agentId", async () => {
    createMock.mockResolvedValue({ id: "cap1", token: "lib.cap1.secret" });
    const res = await actions.createCaptureTokenAction({ label: "work laptop" });
    expect(res).toEqual({ ok: true, id: "cap1", token: "lib.cap1.secret" });
    expect(createMock).toHaveBeenCalledWith({
      agentId: "work laptop",
      scope: "capture",
      label: "work laptop",
    });
    expect(revalidateMock).toHaveBeenCalledWith("/settings/connect");
  });

  it("falls back to a generic agentId and omits the label when no name is given", async () => {
    createMock.mockResolvedValue({ id: "cap2", token: "lib.cap2.secret" });
    const res = await actions.createCaptureTokenAction({});
    expect(res).toEqual({ ok: true, id: "cap2", token: "lib.cap2.secret" });
    expect(createMock).toHaveBeenCalledWith({ agentId: "capture-device", scope: "capture" });
  });

  it("maps a create failure to an error result without revalidating", async () => {
    createMock.mockRejectedValue(new Error("nope"));
    const res = await actions.createCaptureTokenAction({ label: "x" });
    expect(res).toEqual({ ok: false, error: "nope" });
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it("revokes by id and revalidates", async () => {
    revokeMock.mockResolvedValue({ revoked: true });
    const res = await actions.revokeCaptureTokenAction("cap1");
    expect(res).toEqual({ ok: true });
    expect(revokeMock).toHaveBeenCalledWith({ id: "cap1" });
    expect(revalidateMock).toHaveBeenCalledWith("/settings/connect");
  });
});
