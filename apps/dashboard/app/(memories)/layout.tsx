import type { ReactNode } from "react";
import { TabNav } from "@/components/memories/tab-nav";

export default function MemoriesLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <TabNav />
      {children}
    </div>
  );
}
