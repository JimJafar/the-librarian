import type { ReactNode } from "react";
import { TabNav } from "@/components/memories/tab-nav";

// Mirror of app/(memories)/layout.tsx so the Sessions route gets the
// same top tab bar. The (memories) route group can't include /sessions
// (it's a sibling, not a child), so the TabNav has to be re-injected
// here — otherwise the top menu vanishes the moment you click the tab.
export default function SessionsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <TabNav />
      {children}
    </div>
  );
}
