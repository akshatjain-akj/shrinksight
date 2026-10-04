"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import IncidentCard from "@/components/IncidentCard";
import { ErrorNotice, Skeletons } from "@/components/ui";
import { inr, summarise } from "@/lib/format";
import { useIncidents, useStore } from "@/lib/hooks";
import type { Camera, Incident, Zone } from "@/lib/types";

type Filter = "all" | "review" | "rejected";

function CameraTile({ camera, zones, open, selected, onSelect }: {
  camera: Camera;
  zones: Zone[];
  open: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button type="button" className="camera" aria-pressed={selected} onClick={onSelect}
      aria-label={`${camera.name}: ${open} open incident${open === 1 ? "" : "s"}. Show only this camera.`}>
      <span className="camera-label">
        <span className="rec-dot" aria-hidden="true" />
        <span className="chip">{camera.name}</span>
      </span>
      {open > 0 && <span className={`chip tone-danger camera-badge`}>{open} open</span>}
      <span className="camera-center">
        Live footage for the demo store is coming soon. Try “Investigate a clip” to analyse your own.
      </span>
      <span className="camera-zones">
        {zones.map((z) => (
          <span key={z.id} className={`chip ${z.high_value ? "tone-warning" : ""}`}>
            {z.name}
          </span>
        ))}
      </span>
    </button>
  );
}

export default function MonitorPage() {
  const { store, error: storeError } = useStore();
  const { data: incidents, error, live } = useIncidents();
  const [filter, setFilter] = useState<Filter>("all");
  const [cameraId, setCameraId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const stats = useMemo(() => summarise(incidents ?? []), [incidents]);
  const visible = useMemo(() => {
    const byFilter = (i: Incident) =>
      filter === "all" || (filter === "review" ? i.status === "NEEDS_REVIEW" : i.status === "REJECTED");
    return (incidents ?? []).filter((i) => byFilter(i) && (!cameraId || i.camera_id === cameraId));
  }, [incidents, filter, cameraId]);

  const openCount = (id: string) =>
    (incidents ?? []).filter((i) => i.camera_id === id && i.status === "NEEDS_REVIEW").length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{store?.name ?? "Store monitor"}</h1>
          <p>On-device detection flags moments; a Gemini agent investigates each one before anyone is disturbed.</p>
        </div>
        <div className="row">
          <Link href="/investigate" className="btn btn-primary">
            Investigate a clip
          </Link>
          <Link href="/rules" className="btn">
            Store rules
          </Link>
        </div>
      </div>

      <section className="stats" aria-label="Summary">
        <div className="stat">
          <strong>{stats.investigated}</strong>
          <span>Investigated by Gemini</span>
        </div>
        <div className="stat">
          <strong style={{ color: "var(--danger)" }}>{stats.flagged}</strong>
          <span>Flagged</span>
        </div>
        <div className="stat">
          <strong style={{ color: "var(--success)" }}>{stats.rejected}</strong>
          <span>False alarms rejected</span>
        </div>
        <div className="stat">
          <strong style={{ color: "var(--warning)" }}>{stats.needsReview}</strong>
          <span>Waiting for review</span>
        </div>
        <div className="stat">
          <strong>{inr(stats.lossCaught)}</strong>
          <span>Estimated loss caught</span>
        </div>
      </section>

      <div className="grid-main">
        <section aria-labelledby="cameras-title">
          <div className="row" style={{ marginBottom: "0.6rem" }}>
            <h2 id="cameras-title" style={{ margin: 0 }}>
              Cameras
            </h2>
            {cameraId && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCameraId(null)}>
                Show all cameras
              </button>
            )}
          </div>
          {storeError && <ErrorNotice>Couldn’t load the store: {storeError}</ErrorNotice>}
          {!store && !storeError && <Skeletons count={2} />}
          {store && (
            <div className="cameras">
              {store.cameras.map((camera) => (
                <CameraTile
                  key={camera.id}
                  camera={camera}
                  zones={store.zones.filter((z) => camera.zone_ids.includes(z.id))}
                  open={openCount(camera.id)}
                  selected={cameraId === camera.id}
                  onSelect={() => setCameraId(cameraId === camera.id ? null : camera.id)}
                />
              ))}
            </div>
          )}
        </section>

        <section className="card" aria-labelledby="feed-title">
          <div className="row" style={{ marginBottom: "0.6rem" }}>
            <h2 id="feed-title" style={{ margin: 0 }}>
              Incident feed
            </h2>
            <span className="spacer" />
            <span className={`chip ${live ? "tone-success" : ""}`} title={live ? "Updates in real time" : "Refreshing"}>
              {live ? "● Live" : "○ Connecting"}
            </span>
          </div>
          <div className="row" role="group" aria-label="Filter incidents" style={{ marginBottom: "0.75rem" }}>
            {(["all", "review", "rejected"] as Filter[]).map((f) => (
              <button key={f} type="button" className="chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {f === "all" ? "All" : f === "review" ? "Needs review" : "Rejected"}
              </button>
            ))}
          </div>
          {error && <ErrorNotice>Couldn’t load incidents: {error}</ErrorNotice>}
          {!incidents && !error && <Skeletons />}
          {incidents && visible.length === 0 && (
            <p className="muted">No incidents match this filter yet.</p>
          )}
          <div className="feed">
            {visible.map((incident) => (
              <IncidentCard key={incident.id} incident={incident} now={now} />
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
