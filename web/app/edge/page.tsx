"use client";

import { Suspense } from "react";
import EdgeConsole from "@/components/EdgeConsole";
import { Spinner } from "@/components/ui";

export default function EdgePage() {
  return (
    <Suspense fallback={<Spinner label="Opening the edge watcher…" />}>
      <EdgeConsole />
    </Suspense>
  );
}
