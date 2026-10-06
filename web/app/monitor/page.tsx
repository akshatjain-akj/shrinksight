"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import CameraConfig from "@/components/CameraConfig";
import LiveScan from "@/components/LiveScan";
import { ErrorNotice, Skeletons } from "@/components/ui";
import { VERDICT_LABEL } from "@/lib/format";
import EdgeTuningBanner from "@/components/EdgeTuningBanner";
import { armAlertSound, playAlertChime } from "@/lib/alertSound";
import { toTuning, useEdgeConfig, useIncidents, useRules, useStore } from "@/lib/hooks";
import { useClipUrl } from "@/lib/useClip";
import type { Camera, Incident, Rule, Zone } from "@/lib/types";

type Filter = "all" | "review" | "rejected";

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

function openIncidents(incidents: Incident[], cameraId: string): Incident[] {
  return incidents
    .filter((incident) => incident.camera_id === cameraId && incident.status === "NEEDS_REVIEW")
    .slice(0, 2);
}

function boxTone(incident: Incident): "danger" | "muted" | "calm" {
  if (incident.status === "REJECTED" || incident.status === "RESOLVED_DISMISSED") return "muted";
  if (
    incident.status === "RESOLVED_CONFIRMED" ||
    incident.verdict.verdict === "CONCEALMENT" ||
    incident.verdict.verdict === "SCAN_AVOIDANCE"
  ) {
    return "danger";
  }
  return "calm";
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" />
    </svg>
  );
}

function CameraTile({ camera, marks, selected, zones, rules, onSelect, onSettings }: {
  camera: Camera;
  marks: Incident[];
  selected: boolean;
  zones: Zone[];
  rules: Rule[];
  onSelect: () => void;
  onSettings: () => void;
}) {
  const clipUrl = useClipUrl(camera.id);
  const { config } = useEdgeConfig(camera.id);
  const tuning = useMemo(() => toTuning(config), [config]);
  const boxes = marks.length > 0 ? marks : [null];
  return (
    <div className={`camera camera-${camera.kind}${selected ? " is-on" : ""}`}>
      <button
        type="button"
        className="camera-hit"
        aria-pressed={selected}
        onClick={onSelect}
        aria-label={`${camera.name}. ${marks.length} open. Filter the alert list to this camera.`}
      />
      <span className="camera-top">
        <span className="camera-label">
          <span className="rec-dot" aria-hidden="true" />
          <span>{camera.name}</span>
        </span>
        <span className="camera-actions">
          <button
            type="button"
            className="camera-gear"
            aria-label={`Settings for ${camera.name}`}
            onClick={onSettings}
          >
            <GearIcon />
          </button>
          <span className="chip tone-success">Live</span>
        </span>
      </span>
      <span className="camera-scene">
        {clipUrl && <LiveScan src={clipUrl} camera={camera} zones={zones} rules={rules} tuning={tuning} loop />}
        {!clipUrl && boxes.map((incident, index) => (
          <span key={incident?.id ?? "clear"} className={`wall-box wall-box-${index} tone-${incident ? boxTone(incident) : "calm"}`}>
            <span className="wall-tag">
              {incident
                ? `${VERDICT_LABEL[incident.verdict.verdict]} ${Math.round(incident.verdict.confidence * 100)}%`
                : "Clear"}
            </span>
          </span>
        ))}
      </span>
    </div>
  );
}

/** Shows the auto-tune banner for one camera when its gate was changed (Firestore keeps it live). */
function CameraTuning({ camera }: { camera: Camera }) {
  const { config, setConfig } = useEdgeConfig(camera.id);
  return <EdgeTuningBanner config={config} cameraName={camera.name} onChange={setConfig} />;
}

export default function MonitorPage() {
  const { store, error: storeError } = useStore();
  const { data: incidents, error, live } = useIncidents();
  const { data: rules } = useRules();
  const [filter, setFilter] = useState<Filter>("all");
  const [cameraId, setCameraId] = useState<string | null>(null);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!settingsFor) return;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsFor(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsFor]);

  const visible = useMemo(() => {
    const byFilter = (incident: Incident) =>
      filter === "all" || (filter === "review" ? incident.status === "NEEDS_REVIEW" : incident.status === "REJECTED");
    return (incidents ?? []).filter((incident) => byFilter(incident) && (!cameraId || incident.camera_id === cameraId));
  }, [incidents, filter, cameraId]);

  const heard = useRef<Set<string> | null>(null);
  useEffect(() => {
    armAlertSound();
  }, []);
  useEffect(() => {
    if (!incidents) return;
    if (!heard.current) {
      heard.current = new Set(incidents.map((incident) => incident.id));
      return;
    }
    const fresh = incidents.some(
      (incident) => incident.status === "NEEDS_REVIEW" && !heard.current?.has(incident.id),
    );
    heard.current = new Set(incidents.map((incident) => incident.id));
    if (fresh) playAlertChime();
  }, [incidents]);

  const waiting = (incidents ?? []).filter((incident) => incident.status === "NEEDS_REVIEW").length;
  const model = incidents?.[0]?.model ?? "Gemini";
  const edgeCamera = cameraId ?? store?.cameras[0]?.id ?? "cam-sco-1";

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{store?.name ?? "Store monitor"}</h1>
          <p>Live cameras on the floor. Gemini has already reviewed the alerts on the right.</p>
        </div>
        <div className="row">
          <span className={`chip ${live ? "tone-success" : ""}`}>{live ? "Live" : "Connecting"}</span>
          <Link href="/investigate" className="btn btn-primary">Investigate a clip</Link>
          <Link href="/rules" className="btn">Store rules</Link>
        </div>
      </div>

      <div className="grid-main wall-layout">
        <section aria-labelledby="cameras-title">
          <div className="row" style={{ marginBottom: "0.6rem" }}>
            <h2 id="cameras-title" style={{ margin: 0 }}>Cameras</h2>
            <span className="spacer" />
            <Link href={`/edge?camera=${edgeCamera}`}>Open live edge</Link>
            {cameraId && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCameraId(null)}>
                Show all cameras
              </button>
            )}
          </div>
          {storeError && <ErrorNotice>Couldn’t load the store: {storeError}</ErrorNotice>}
          {!store && !storeError && <Skeletons count={2} />}
          {store && (
            <div className="stack" style={{ marginBottom: "0.6rem" }}>
              {store.cameras.map((camera) => (
                <CameraTuning key={camera.id} camera={camera} />
              ))}
            </div>
          )}
          {store && (
            <div className="cameras">
              {store.cameras.map((camera) => (
                <CameraTile
                  key={camera.id}
                  camera={camera}
                  marks={openIncidents(incidents ?? [], camera.id)}
                  selected={cameraId === camera.id}
                  zones={store.zones}
                  rules={rules ?? []}
                  onSelect={() => setCameraId(cameraId === camera.id ? null : camera.id)}
                  onSettings={() => setSettingsFor(camera.id)}
                />
              ))}
            </div>
          )}
          <p className="wall-status">
            <span className="tone-ok">All systems operational</span>
            <span>Active alerts: {waiting}</span>
            <span>AI model: {model}</span>
          </p>
        </section>

        <section className="card alert-rail" aria-labelledby="feed-title">
          <div className="row" style={{ marginBottom: "0.6rem" }}>
            <h2 id="feed-title" style={{ margin: 0 }}>Alerts & activity</h2>
          </div>
          <div className="row" role="group" aria-label="Filter incidents" style={{ marginBottom: "0.75rem" }}>
            {(["all", "review", "rejected"] as Filter[]).map((item) => (
              <button key={item} type="button" className="chip" aria-pressed={filter === item} onClick={() => setFilter(item)}>
                {item === "all" ? "All" : item === "review" ? "Needs review" : "Rejected"}
              </button>
            ))}
          </div>
          {error && <ErrorNotice>Couldn’t load incidents: {error}</ErrorNotice>}
          {!incidents && !error && <Skeletons />}
          {incidents && visible.length === 0 && <p className="muted">No alerts match this filter yet.</p>}
          <div className="feed">
            {visible.map((incident) => (
              <Link key={incident.id} href={`/incident?id=${encodeURIComponent(incident.id)}`} className="alert-row">
                <time dateTime={incident.created_at}>{clock(incident.created_at)}</time>
                <span>
                  <strong>{VERDICT_LABEL[incident.verdict.verdict]}</strong>
                  <span className="muted"> · {incident.camera_name}</span>
                </span>
              </Link>
            ))}
          </div>
          <p className="muted small">Times use the store clock. Updated {new Date(now).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}.</p>
        </section>
      </div>
      {settingsFor && (
        <div className="settings-pop" onClick={() => setSettingsFor(null)}>
          <div
            className="settings-pop-card"
            role="dialog"
            aria-modal="true"
            aria-label="Camera configuration"
            tabIndex={-1}
            ref={dialogRef}
            onClick={(event) => event.stopPropagation()}
          >
            <button type="button" className="settings-pop-close" aria-label="Close settings" onClick={() => setSettingsFor(null)}>
              Close
            </button>
            <CameraConfig initialCameraId={settingsFor} />
          </div>
        </div>
      )}
    </>
  );
}
