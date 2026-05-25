import { describe, expect, it, vi } from "vitest";
import { authorizeOwnerCredentials } from "@/lib/credentials-authorize";

// D3.1: the Credentials provider's authorize logic, extracted so it's testable
// without standing up NextAuth. verify() is the store-side auth.verifyPassword
// (lockout-aware); authorize returns the single-owner identity on ok, null otherwise.

describe("authorizeOwnerCredentials", () => {
  it("returns the owner identity when verify succeeds", async () => {
    const verify = vi.fn().mockResolvedValue({ ok: true, locked: false });
    const user = await authorizeOwnerCredentials({ username: "owner", password: "pw" }, verify);
    expect(user).toEqual({ id: "owner", name: "owner" });
    expect(verify).toHaveBeenCalledWith("owner", "pw");
  });

  it("returns null when verify fails", async () => {
    const verify = vi.fn().mockResolvedValue({ ok: false, locked: false });
    expect(
      await authorizeOwnerCredentials({ username: "owner", password: "bad" }, verify),
    ).toBeNull();
  });

  it("returns null when locked out (verify ok:false)", async () => {
    const verify = vi.fn().mockResolvedValue({ ok: false, locked: true });
    expect(
      await authorizeOwnerCredentials({ username: "owner", password: "pw" }, verify),
    ).toBeNull();
  });

  it("returns null on missing/invalid credentials without calling verify", async () => {
    const verify = vi.fn();
    expect(await authorizeOwnerCredentials({ username: "owner" }, verify)).toBeNull();
    expect(await authorizeOwnerCredentials({ password: "pw" }, verify)).toBeNull();
    expect(await authorizeOwnerCredentials({ username: 123, password: "pw" }, verify)).toBeNull();
    expect(verify).not.toHaveBeenCalled();
  });

  it("fails closed (null) when verify throws (store/proxy error)", async () => {
    const verify = vi.fn().mockRejectedValue(new Error("unreachable"));
    expect(
      await authorizeOwnerCredentials({ username: "owner", password: "pw" }, verify),
    ).toBeNull();
  });
});
