"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import IncidentDetail from "@/components/IncidentDetail";
import { ErrorNotice, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { localClipNote, useLocalClip } from "@/lib/useLocalClip";
import type { Incident } from "@/lib/types";

function IncidentLoader() {
  const id = useSearchParams().get("id");
  const [incident, setIncident] = useState<Incident | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Clips aren't stored on the server; this device may still hold its own copy for 24 hours.
  const local = useLocalClip(id);

  useEffect(() => {
    if (!id) return;
    setError(null);
    api
      .incident(id)
      .then(setIncident)
      .catch((e: Error) => setError(e.message));
  }, [id, attempt]);

  if (!id) return <ErrorNotice>No incident selected.</ErrorNotice>;
  if (error) return <ErrorNotice onRetry={() => setAttempt((a) => a + 1)}>{error}</ErrorNotice>;
  if (!incident) return <Spinner label="Loading incident…" />;
  return (
    <IncidentDetail
      incident={incident}
      videoUrl={local.url ?? undefined}
      videoNote={local.expiresAt ? localClipNote(local.expiresAt) : undefined}
    />
  );
}

export default function IncidentPage() {
  return (
    <>
      <p style={{ marginTop: 0 }}>
        <Link href="/monitor">← Back to monitor</Link>
      </p>
      <Suspense fallback={<Spinner label="Loading incident…" />}>
        <IncidentLoader />
      </Suspense>
    </>
  );
}
