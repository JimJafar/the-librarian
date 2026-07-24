import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Providers } from "@/components/providers";

let pathname = "/memories";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

vi.mock("@/lib/trpc-client", () => ({
  createBrowserTRPCClient: () => ({}),
  trpc: {
    Provider: ({ children }: { children: ReactNode }) => children,
  },
}));

function CaptureClient({ onClient }: { onClient: (client: QueryClient) => void }) {
  const client = useQueryClient();
  useEffect(() => {
    onClient(client);
  }, [client, onClient]);
  return null;
}

describe("dashboard query-provider isolation", () => {
  beforeEach(() => {
    pathname = "/memories";
  });

  it("replaces the query cache when the authenticated principal changes", () => {
    const clients: QueryClient[] = [];
    const onClient = (client: QueryClient) => clients.push(client);
    const { rerender } = render(
      <Providers queryScope="github:alice">
        <CaptureClient onClient={onClient} />
      </Providers>,
    );
    const aliceClient = clients.at(-1);
    aliceClient?.setQueryData(["vault", "shelves"], [{ id: "alice" }]);

    rerender(
      <Providers queryScope="github:bob">
        <CaptureClient onClient={onClient} />
      </Providers>,
    );

    const bobClient = clients.at(-1);
    expect(bobClient).not.toBe(aliceClient);
    expect(bobClient?.getQueryData(["vault", "shelves"])).toBeUndefined();
  });

  it("replaces the query cache on auth-route navigation even if the layout scope is stale", () => {
    const clients: QueryClient[] = [];
    const onClient = (client: QueryClient) => clients.push(client);
    const { rerender } = render(
      <Providers queryScope="github:alice">
        <CaptureClient onClient={onClient} />
      </Providers>,
    );
    const authenticatedClient = clients.at(-1);
    authenticatedClient?.setQueryData(["memories", "list"], [{ id: "private" }]);

    pathname = "/login";
    rerender(
      <Providers queryScope="github:alice">
        <CaptureClient onClient={onClient} />
      </Providers>,
    );

    const loginClient = clients.at(-1);
    expect(loginClient).not.toBe(authenticatedClient);
    expect(loginClient?.getQueryData(["memories", "list"])).toBeUndefined();
  });

  it("preserves the query cache across ordinary navigations", () => {
    const clients: QueryClient[] = [];
    const onClient = (client: QueryClient) => clients.push(client);
    const { rerender } = render(
      <Providers queryScope="github:alice">
        <CaptureClient onClient={onClient} />
      </Providers>,
    );
    const memoriesClient = clients.at(-1);
    memoriesClient?.setQueryData(["vault", "shelves"], [{ id: "personal" }]);

    pathname = "/handoffs";
    rerender(
      <Providers queryScope="github:alice">
        <CaptureClient onClient={onClient} />
      </Providers>,
    );

    const handoffsClient = clients.at(-1);
    expect(handoffsClient).toBe(memoriesClient);
    expect(handoffsClient?.getQueryData(["vault", "shelves"])).toEqual([{ id: "personal" }]);
  });
});
