import { afterEach, describe, expect, it, vi } from "vitest";

const createMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();
const recallMock = vi.fn();
const revalidateMock = vi.fn();

vi.mock("@/lib/trpc-server", () => ({
  serverTRPC: {
    memories: {
      create: { mutate: createMock },
      update: { mutate: updateMock },
      delete: { mutate: deleteMock },
      recall: { mutate: recallMock },
    },
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: revalidateMock,
}));

const actions = await import("../app/(memories)/actions");

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

describe("memories actions", () => {
  afterEach(() => {
    createMock.mockReset();
    updateMock.mockReset();
    deleteMock.mockReset();
    recallMock.mockReset();
    revalidateMock.mockReset();
  });

  it("createMemoryAction forwards form fields and revalidates", async () => {
    createMock.mockResolvedValueOnce({ id: "mem_1" });
    const result = await actions.createMemoryAction(
      form({ title: "T", body: "B", category: "lessons", tags: "a, b" }),
    );
    expect(result).toEqual({ ok: true });
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "T",
        body: "B",
        category: "lessons",
        tags: ["a", "b"],
      }),
    );
    expect(revalidateMock).toHaveBeenCalledWith("/");
  });

  it("updateMemoryAction wraps fields in a patch", async () => {
    updateMock.mockResolvedValueOnce({});
    await actions.updateMemoryAction("mem_1", form({ title: "X" }));
    expect(updateMock).toHaveBeenCalledWith({
      id: "mem_1",
      patch: expect.objectContaining({ title: "X" }),
    });
  });

  it("deleteMemoryAction passes the id", async () => {
    deleteMock.mockResolvedValueOnce({});
    await actions.deleteMemoryAction("mem_1");
    expect(deleteMock).toHaveBeenCalledWith({ id: "mem_1" });
  });

  it("recallAction returns ok and memories on success", async () => {
    const memories = [{ id: "mem_1" }, { id: "mem_2" }];
    recallMock.mockResolvedValueOnce({ memories });
    const result = await actions.recallAction("hello");
    expect(result).toEqual({ ok: true, memories });
    expect(recallMock).toHaveBeenCalledWith({ query: "hello", limit: 12 });
  });

  it("recallAction rejects empty queries", async () => {
    const result = await actions.recallAction("   ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/empty/i);
    expect(recallMock).not.toHaveBeenCalled();
  });

  it("createMemoryAction surfaces upstream errors", async () => {
    createMock.mockRejectedValueOnce(new Error("upstream boom"));
    const result = await actions.createMemoryAction(form({ title: "T" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("upstream boom");
  });
});
