"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import IncidentDetail from "@/components/IncidentDetail";
import { ErrorNotice, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { openForReview } from "@/lib/demoAlerts";
import { localClipNote, useLocalClip } from "@/lib/useLocalClip";
import { useClipUrl, useDemoClipUrl } from "@/lib/useClip";
import type { Incident } from "@/lib/types";

function IncidentLoader() {
  const id = useSearchParams().get("id");
  const router = useRouter();
  const [incident, setIncident] = useState<Incident | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Clips aren't stored on the server; this device may still hold its own copy for 24 hours.
  const local = useLocalClip(id);
  // A demo clip's result always has its video: the clip it was analysed from.
  const demoUrl = useDemoClipUrl(incident?.clip_ref);
  // Seed alerts have no clip of their own. Play the lane camera's clip, which is already on the monitor.
  const laneUrl = useClipUrl(incident && !incident.clip_ref ? incident.camera_id : null);

  useEffect(() => {
    if (!id) return;
    setError(null);
    api
      .incident(id)
      .then(async (item) => {
        // Example incidents are written by hand. If this lane already has a Gemini result for its clip, show that.
        if (item.source === "seed") {
          const [demos, store] = await Promise.all([
            api.demoIncidents().catch(() => [] as Incident[]),
            api.store().catch(() => null),
          ]);
          const clip = store?.cameras.find((camera) => camera.id === item.camera_id)?.demo_clip;
          const real =
            demos.find((demo) => demo.camera_id === item.camera_id && demo.clip_ref === clip) ??
            demos.find((demo) => demo.camera_id === item.camera_id);
          if (real && real.id !== item.id) {
            router.replace(`/incident?id=${encodeURIComponent(real.id)}`);
            return;
          }
        }
        setIncident(openForReview(item));
      })
      .catch((e: Error) => setError(e.message));
  }, [id, attempt, router]);

  if (!id) return <ErrorNotice>No incident selected.</ErrorNotice>;
  if (error) return <ErrorNotice onRetry={() => setAttempt((a) => a + 1)}>{error}</ErrorNotice>;
  if (!incident) return <Spinner label="Loading incident…" />;
  return (
    <IncidentDetail
      incident={incident}
      videoUrl={demoUrl ?? laneUrl ?? local.url ?? undefined}
      videoNote={
        demoUrl
          ? "Demo clip · analysed once by Gemini; this is its stored result"
          : laneUrl
            ? "This lane's camera clip"
            : local.expiresAt
              ? localClipNote(local.expiresAt)
              : undefined
      }
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
