import { describe, expect, it } from "vitest";
import {
  type AuthConfigShape,
  decideEnforcement,
  isAuthEnforced,
  resolveEnforcement,
  toEnforcementConfig,
} from "@/lib/auth-gate";

// A2: enforcement is feature-flagged so login can be wired (A1) before it is
// enforced — no slice can lock the owner out mid-rollout.
describe("isAuthEnforced", () => {
  it("is on only for the exact string 'true'", () => {
    expect(isAuthEnforced({ LIBRARIAN_AUTH_ENABLED: "true" })).toBe(true);
  });

  it("is off when unset, empty, or any other value", () => {
    expect(isAuthEnforced({})).toBe(false);
    expect(isAuthEnforced({ LIBRARIAN_AUTH_ENABLED: "" })).toBe(false);
    expect(isAuthEnforced({ LIBRARIAN_AUTH_ENABLED: "false" })).toBe(false);
    expect(isAuthEnforced({ LIBRARIAN_AUTH_ENABLED: "1" })).toBe(false);
    expect(isAuthEnforced({ LIBRARIAN_AUTH_ENABLED: "TRUE" })).toBe(false);
  });
});

// D2.4: store-driven, fail-closed enforcement decision.
describe("decideEnforcement", () => {
  it("is open when the store config is disabled", () => {
    expect(decideEnforcement({ enabled: false, complete: true }, false)).toBe("open");
  });

  it("enforces when enabled and complete", () => {
    expect(decideEnforcement({ enabled: true, complete: true }, false)).toBe("enforce");
  });

  it("blocks (fail closed) when enabled but incomplete", () => {
    expect(decideEnforcement({ enabled: true, complete: false }, false)).toBe("block");
  });

  it("blocks (fail closed) when the store is unreachable", () => {
    expect(decideEnforcement("unreachable", false)).toBe("block");
    expect(decideEnforcement("unreachable", true)).toBe("block");
  });

  it("falls back to the env flag when there is no store config", () => {
    expect(decideEnforcement(null, true)).toBe("enforce"); // legacy env deploy
    expect(decideEnforcement(null, false)).toBe("open");
  });
});

describe("toEnforcementConfig", () => {
  const base: AuthConfigShape = { enabled: false, methods: [], authSecret: null };

  it("treats an unconfigured store as null (fall back to env)", () => {
    expect(toEnforcementConfig(base)).toBeNull();
    expect(toEnforcementConfig(null)).toBeNull();
  });

  it("is store-managed once a method is configured, and reports completeness", () => {
    const cfg: AuthConfigShape = { enabled: false, methods: ["password"], authSecret: "deadbeef" };
    expect(toEnforcementConfig(cfg)).toEqual({ enabled: false, complete: true });
  });

  it("an enabled config with no derivable secret is incomplete", () => {
    const cfg: AuthConfigShape = { enabled: true, methods: ["password"], authSecret: null };
    expect(toEnforcementConfig(cfg)).toEqual({ enabled: true, complete: false });
  });

  it("OAuth needs both creds and an owner to count as complete", () => {
    const credsOnly: AuthConfigShape = {
      enabled: true,
      methods: ["github"],
      authSecret: "x",
      oauth: { github: { clientId: "a", clientSecret: "b" } },
      ownerOAuth: {},
    };
    expect(toEnforcementConfig(credsOnly)).toEqual({ enabled: true, complete: false });

    const withOwner: AuthConfigShape = { ...credsOnly, ownerOAuth: { github: "octocat" } };
    expect(toEnforcementConfig(withOwner)).toEqual({ enabled: true, complete: true });
  });
});

describe("resolveEnforcement", () => {
  const enabledComplete: AuthConfigShape = {
    enabled: true,
    methods: ["password"],
    authSecret: "deadbeef",
  };

  it("fails closed to block when the config fetch throws (store outage)", async () => {
    const fetchConfig = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await resolveEnforcement(fetchConfig, {})).toBe("block");
  });

  it("enforces when the store says enabled + complete", async () => {
    expect(await resolveEnforcement(async () => enabledComplete, {})).toBe("enforce");
  });

  it("env-fallback deploy still authenticates (no store config, env enabled)", async () => {
    expect(await resolveEnforcement(async () => null, { LIBRARIAN_AUTH_ENABLED: "true" })).toBe(
      "enforce",
    );
  });

  it("stays open when neither the store nor the env enables auth", async () => {
    expect(await resolveEnforcement(async () => null, {})).toBe("open");
  });
});
