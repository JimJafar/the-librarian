// Vault explorer/editor server actions (rethink T19, spec §8 / D15): thin
// forwards to the admin vault router — save carries the compare-and-swap hash,
// every mutation revalidates the vault view, and server teaching errors
// (validation, conflict) surface verbatim as { ok: false, error }.

import { afterEach, describe, expect, it, vi } from "vitest";

const writeMock = vi.fn();
const createMock = vi.fn();
const renameMock = vi.fn();
const deleteMock = vi.fn();
const revalidateMock = vi.fn();

vi.mock("@/lib/trpc-server", () => ({
  serverTRPC: {
    vault: {
      write: { mutate: writeMock },
      create: { mutate: createMock },
      rename: { mutate: renameMock },
      delete: { mutate: deleteMock },
    },
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: revalidateMock,
}));

const actions = await import("../app/vault/actions");

describe("vault actions", () => {
  afterEach(() => {
    writeMock.mockReset();
    createMock.mockReset();
    renameMock.mockReset();
    deleteMock.mockReset();
    revalidateMock.mockReset();
  });

  it("saveVaultFileAction forwards path + raw + expectedHash and revalidates", async () => {
    writeMock.mockResolvedValueOnce({ hash: "abc" });
    const result = await actions.saveVaultFileAction({
      path: "references/guide.md",
      raw: "# Guide v2\n",
      expectedHash: "stale-or-current",
    });
    expect(result).toEqual({ ok: true, hash: "abc" });
    expect(writeMock).toHaveBeenCalledWith({
      path: "references/guide.md",
      raw: "# Guide v2\n",
      expectedHash: "stale-or-current",
    });
    expect(revalidateMock).toHaveBeenCalledWith("/");
  });

  it("saveVaultFileAction surfaces validation/conflict errors verbatim", async () => {
    writeMock.mockRejectedValueOnce(new Error("'references/guide.md' changed since you loaded it"));
    const result = await actions.saveVaultFileAction({
      path: "references/guide.md",
      raw: "x",
      expectedHash: "stale",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/changed since you loaded it/);
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it("createVaultFileAction forwards and revalidates", async () => {
    createMock.mockResolvedValueOnce({ hash: "h" });
    const result = await actions.createVaultFileAction({
      path: "references/new.md",
      raw: "# New\n",
    });
    expect(result).toEqual({ ok: true });
    expect(createMock).toHaveBeenCalledWith({ path: "references/new.md", raw: "# New\n" });
    expect(revalidateMock).toHaveBeenCalledWith("/");
  });

  it("renameVaultFileAction returns the new path + rewritten-link list", async () => {
    renameMock.mockResolvedValueOnce({
      path: "references/new-name.md",
      changedLinks: ["references/citing.md"],
    });
    const result = await actions.renameVaultFileAction({
      from: "references/old-name.md",
      to: "references/new-name.md",
    });
    expect(result).toEqual({
      ok: true,
      path: "references/new-name.md",
      changedLinks: ["references/citing.md"],
    });
  });

  it("deleteVaultFileAction forwards the path", async () => {
    deleteMock.mockResolvedValueOnce({ deleted: "references/old.md" });
    const result = await actions.deleteVaultFileAction({ path: "references/old.md" });
    expect(result).toEqual({ ok: true });
    expect(deleteMock).toHaveBeenCalledWith({ path: "references/old.md" });
  });
});
