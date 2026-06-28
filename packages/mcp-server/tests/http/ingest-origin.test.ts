// Ingest spec criterion 1 / S1 — the browser-extension origin gate.
//
// A Chromium MV3 background service worker POSTs to /ingest with an
// `Origin: chrome-extension://<id>` header. The same-host origin rule would 403
// it before dispatch, so the gate must let any `chrome-extension:` scheme origin
// through. The real gate on /ingest is the capture bearer token (D28); a web page
// cannot forge a `chrome-extension://` origin, and the server is bearer- not
// cookie-authed so CSRF isn't the threat. Unit-tests the compiled auth seam.

import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { type AuthConfig, isAllowedOrigin } from "../../dist/http/auth.js";

function reqWithOrigin(origin?: string, host = "0.0.0.0:3838"): IncomingMessage {
  return {
    headers: { ...(origin ? { origin } : {}), host },
  } as unknown as IncomingMessage;
}

const config: AuthConfig = {
  adminToken: "",
  agentToken: "",
  agentTokenMap: new Map(),
  allowedOrigins: [],
  allowNoAuth: false,
  host: "0.0.0.0",
  port: 3838,
};

describe("isAllowedOrigin — chrome-extension origins", () => {
  it("accepts a chrome-extension:// origin (the browser-extension capture path)", () => {
    expect(isAllowedOrigin(reqWithOrigin("chrome-extension://abc"), config)).toBe(true);
  });

  it("still rejects a stray cross-site https origin under the same-host rule", () => {
    expect(isAllowedOrigin(reqWithOrigin("https://evil.com"), config)).toBe(false);
  });

  it("still accepts a same-host origin", () => {
    expect(isAllowedOrigin(reqWithOrigin("http://0.0.0.0:3838"), config)).toBe(true);
  });
});
