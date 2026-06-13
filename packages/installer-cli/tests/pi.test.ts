import { afterEach, describe, expect, it } from "vitest";
import { resetRunner, setRunner } from "../src/exec.js";
import { pi } from "../src/harnesses/pi.js";
import { FakeRunner } from "./helpers.js";

const CFG = {
  mcpUrl: "https://x.example/mcp",
  token: "secret-token-xyz",
  serverUrl: "https://x.example",
};

afterEach(() => resetRunner());

describe("pi harness", () => {
  it("detect: not installed when `pi` is absent from PATH", async () => {
    setRunner(new FakeRunner());
    await expect(pi.detect()).resolves.toEqual({ installed: false });
  });

  it("detect: not installed when CLI present but extension not listed", async () => {
    setRunner(
      new FakeRunner().withWhich("pi").onRun("pi", ["list"], { stdout: "other-extension 1.0.0\n" }),
    );
    await expect(pi.detect()).resolves.toEqual({ installed: false });
  });

  it("detect: installed + version parsed from `pi list`", async () => {
    setRunner(
      new FakeRunner()
        .withWhich("pi")
        .onRun("pi", ["list"], { stdout: "@the-librarian/pi-extension v2.3.4\n" }),
    );
    await expect(pi.detect()).resolves.toEqual({ installed: true, version: "2.3.4" });
  });

  it("install: runs `pi install npm:@the-librarian/pi-extension`", async () => {
    const r = new FakeRunner().withWhich("pi"); // list returns "" → not present
    setRunner(r);
    await pi.install(CFG);
    expect(r.ran("pi", ["install", "npm:@the-librarian/pi-extension"])).toBe(true);
  });

  it("install: idempotent — no install call when already listed", async () => {
    const r = new FakeRunner()
      .withWhich("pi")
      .onRun("pi", ["list"], { stdout: "@the-librarian/pi-extension 1.0.0\n" });
    setRunner(r);
    await pi.install(CFG);
    expect(r.ran("pi", ["install", "npm:@the-librarian/pi-extension"])).toBe(false);
  });

  it("install: throws a friendly error when `pi` is not on PATH", async () => {
    setRunner(new FakeRunner());
    await expect(pi.install(CFG)).rejects.toThrow(/Pi CLI not found on PATH/);
  });

  it("uninstall: runs `pi uninstall @the-librarian/pi-extension`; no-op when CLI absent", async () => {
    const r = new FakeRunner().withWhich("pi");
    setRunner(r);
    await pi.uninstall();
    expect(r.ran("pi", ["uninstall", "@the-librarian/pi-extension"])).toBe(true);

    const empty = new FakeRunner();
    setRunner(empty);
    await expect(pi.uninstall()).resolves.toBeUndefined();
    expect(empty.calls.filter((c) => c.cmd === "pi")).toHaveLength(0);
  });

  it("never passes the token anywhere", async () => {
    const r = new FakeRunner().withWhich("pi");
    setRunner(r);
    await pi.install(CFG);
    expect(JSON.stringify(r.calls)).not.toContain(CFG.token);
  });
});
