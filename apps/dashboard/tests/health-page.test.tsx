import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const pingMock = vi.fn();

vi.mock("@/lib/trpc-server", () => ({
  serverTRPC: {
    health: { ping: { query: () => pingMock() } },
  },
}));

const { default: HealthPage } = await import("../app/health/page");

describe("apps/dashboard/app/health/page.tsx", () => {
  afterEach(() => pingMock.mockReset());

  it('renders {"ok":true} when the tRPC health.ping call succeeds', async () => {
    pingMock.mockResolvedValueOnce({ ok: true });
    const html = renderToString(await HealthPage());
    expect(html).toMatch(/&quot;ok&quot;:true/);
  });

  it("renders the error payload when the call fails", async () => {
    pingMock.mockRejectedValueOnce(new Error("boom"));
    const html = renderToString(await HealthPage());
    expect(html).toMatch(/&quot;ok&quot;:false/);
    expect(html).toMatch(/boom/);
  });
});
