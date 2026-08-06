"use client";

// Client-side Tabs shell for /settings/curator. The page is a server
// component (data fetched server-side); this wrapper holds the
// active-tab state and renders the three job panels.

import type { ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui-v2/tabs";

export function CuratorTabs({
  intake,
  grooming,
  chronicle,
}: {
  intake: ReactNode;
  grooming: ReactNode;
  chronicle: ReactNode;
}) {
  return (
    <Tabs defaultValue="intake">
      <TabsList aria-label="Curator job">
        <TabsTrigger value="intake">Intake</TabsTrigger>
        <TabsTrigger value="grooming">Grooming</TabsTrigger>
        <TabsTrigger value="chronicle">Chronicle</TabsTrigger>
      </TabsList>
      <TabsContent value="intake" className="pt-6">
        {intake}
      </TabsContent>
      <TabsContent value="grooming" className="pt-6">
        {grooming}
      </TabsContent>
      <TabsContent value="chronicle" className="pt-6">
        {chronicle}
      </TabsContent>
    </Tabs>
  );
}
