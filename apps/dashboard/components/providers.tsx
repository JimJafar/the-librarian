"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useState } from "react";
import { createBrowserTRPCClient, trpc } from "@/lib/trpc-client";

export function Providers({ children, queryScope }: { children: ReactNode; queryScope: string }) {
  const pathname = usePathname() ?? "";
  // App Router layouts persist across navigation. Remount the client cache for
  // an identity change, and also at the login boundary in case the root
  // layout's server-rendered session prop has not refreshed yet.
  const cacheScope = JSON.stringify([queryScope, pathname]);
  return <ScopedProviders key={cacheScope}>{children}</ScopedProviders>;
}

function ScopedProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() => createBrowserTRPCClient());
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
