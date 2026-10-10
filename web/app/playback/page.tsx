"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import LiveScan, { type ScanReading } from "@/components/LiveScan";
import { ErrorNotice, Skeletons } from "@/components/ui";
import { VERDICT_LABEL, clipSeconds } from "@/lib/format";
import { useIncidents, useRules, useStore } from "@/lib/hooks";
import { useDemoClipUrl } from "@/lib/useClip";
import { forDemoMode, useDemoMode } from "@/lib/demoMode";
import { localClipNote, useLocalClip } from "@/lib/useLocalClip";
import type { Incident, VerdictKind } from "@/lib/types";

type Range = "24h" | "7d" | "all";
type EventFilter = "all" | VerdictKind;

const RANGES: { id: Range; label: string }[] = [
  { id: "24h", label: "Last 24 hours" },
  { id: "7d", label: "Last 7 days" },
  { id: "all", label: "All" },
];

const EVENTS: { id: EventFilter; label: string }[] = [
  { id: "all", label: "All events" },
  { id: "CONCEALMENT", label: "Concealment" },
  { id: "SCAN_AVOIDANCE", label: "Scan avoidance" },
  { id: "RULE_BREACH", label: "Rule breach" },
  { id: "BENIGN", label: "False alarm" },
];

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

function within(iso: string, range: Range, now: number): boolean {
  if (range === "all") return true;
  const age = now - new Date(iso).getTime();
  const limit = range === "24h" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  return age <= limit;
}

function markColor(event: string, verdict: VerdictKind): "danger" | "ok" | "info" {
  const text = event.toLowerCase();
  if (text.includes("conceal") || text.includes("scan") || text.includes("pocket") || text.includes("floor") || text.includes("medical") || verdict === "CONCEALMENT" || verdict === "SCAN_AVOIDANCE") {
    return "danger";
  }
  if (text.includes("false") || text.includes("benign") || verdict === "BENIGN") return "ok";
  return "info";
}

function clipStamp(seconds: number): string {
  const whole = Math.max(0, seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(1).padStart(4, "0")}`;
}

function Timeline({ incident }: { incident: Incident }) {
  const events = incident.verdict.timeline ?? [];
  const span = Math.max(8, ...events.map((event) => clipSeconds(event.t)), 1);
  if (events.length === 0) {
    return (
      <div className="play-track" aria-hidden="true">
        <span className={`play-mark tone-${markColor("", incident.verdict.verdict)}`} style={{ left: "8%", width: "84%" }} />
      </div>
    );
  }
  return (
    <div className="play-track" aria-label="Incident timeline">
      {events.map((event, index) => {
        const at = clipSeconds(event.t) / span;
        return (
          <span
            key={`${event.t}-${index}`}
            className={`play-mark tone-${markColor(event.event, incident.verdict.verdict)}`}
            style={{ left: `${Math.min(92, at * 100)}%`, width: "6%" }}
            title={`${event.t} ${event.event}`}
          />
        );
      })}
    </div>
  );
}

export default function PlaybackPage() {
  const { store, error: storeError } = useStore();
  const { data: allIncidents, error } = useIncidents();
  const [demoOn] = useDemoMode();
  // Demo-clip incidents (one per demo clip) are listed only in demo mode.
  const incidents = useMemo(() => (allIncidents ? forDemoMode(allIncidents, demoOn) : null), [allIncidents, demoOn]);
  const [range, setRange] = useState<Range>("24h");
  const [cameraId, setCameraId] = useState("all");
  const [eventType, setEventType] = useState<EventFilter>("all");
  const [applied, setApplied] = useState({ range: "24h" as Range, cameraId: "all", eventType: "all" as EventFilter });
  const [picked, setPicked] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanReading[]>([]);
  const [aspect, setAspect] = useState<number | null>(null);
  const playerRef = useRef<HTMLElement>(null);
  const { data: rules } = useRules();

  const results = useMemo(() => {
    const now = Date.now();
    return (incidents ?? []).filter((incident) => {
      // A demo clip's result is its recording, whenever it was analysed.
      if (incident.source !== "demo" && !within(incident.created_at, applied.range, now)) return false;
      if (applied.cameraId !== "all" && incident.camera_id !== applied.cameraId) return false;
      if (applied.eventType !== "all" && incident.verdict.verdict !== applied.eventType) return false;
      return true;
    });
  }, [incidents, applied]);

  const selected =
    results.find((incident) => incident.id === picked) ??
    (picked === null ? results.find((incident) => incident.source === "demo") : undefined) ??
    results[0] ??
    null;
  // A demo incident plays the clip it was analysed from; any other incident, this device's own copy if it has one.
  const demoClipUrl = useDemoClipUrl(selected?.clip_ref);
  const local = useLocalClip(selected?.clip_ref ? null : selected?.id);
  const clipUrl = demoClipUrl ?? local.url;

  useEffect(() => {
    setScan([]);
    setAspect(null);
  }, [selected?.id]);

  // On a phone the player sits above the results: picking one brings the player back into view.
  const pick = (id: string) => {
    setPicked(id);
    if (!window.matchMedia("(max-width: 900px)").matches) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    playerRef.current?.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
  };

  const noteScan = (reading: ScanReading) => {
    setScan((current) => {
      const last = current[current.length - 1];
      if (last && reading.t + 0.4 < last.t) return [reading];
      if (last?.detail === reading.detail) return current;
      return [...current, reading].slice(-8);
    });
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Search & playback</h1>
          <p>Find a reviewed moment by time, camera, and event. The clip itself is not kept after Gemini replies.</p>
          <p className="playback-retention">
            False alarms are deleted after 1 day. Real theft and hazards are deleted after 7 days. Seeded demo clips stay.
          </p>
        </div>
      </div>

      <form
        className="playback-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setApplied({ range, cameraId, eventType });
          setPicked(null);
        }}
      >
        <label>
          Date range
          <select value={range} onChange={(event) => setRange(event.target.value as Range)}>
            {RANGES.map((item) => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </select>
        </label>
        <label>
          Camera
          <select value={cameraId} onChange={(event) => setCameraId(event.target.value)}>
            <option value="all">All cameras</option>
            {store?.cameras.map((camera) => (
              <option key={camera.id} value={camera.id}>{camera.name}</option>
            ))}
          </select>
        </label>
        <label>
          Event type
          <select value={eventType} onChange={(event) => setEventType(event.target.value as EventFilter)}>
            {EVENTS.map((item) => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-primary">Search</button>
      </form>

      {storeError && <ErrorNotice>Couldn’t load the store: {storeError}</ErrorNotice>}
      {error && <ErrorNotice>Couldn’t load incidents: {error}</ErrorNotice>}

      <div className="playback">
        <section aria-labelledby="results-title">
          <h2 id="results-title">Results</h2>
          {!incidents && !error && <Skeletons count={3} />}
          {incidents && results.length === 0 && <p className="muted">No results match this search.</p>}
          <div className="playback-grid">
            {results.map((incident) => (
              <button
                key={incident.id}
                type="button"
                className={`playback-tile camera-${incident.camera_kind}`}
                aria-pressed={selected?.id === incident.id}
                onClick={() => pick(incident.id)}
              >
                <span className="wall-tag">{VERDICT_LABEL[incident.verdict.verdict]}</span>
                <span className="playback-meta">
                  {clock(incident.created_at)} · {incident.camera_name}
                </span>
              </button>
            ))}
          </div>
        </section>

        <section ref={playerRef} className="card playback-player" aria-labelledby="player-title">
          <h2 id="player-title">Playback</h2>
          {!selected && <p className="muted">Select a result to see the timeline.</p>}
          {selected && (
            <>
              <p className="playback-heading">
                <strong>{selected.camera_name}</strong>
                <span className="muted"> · {clock(selected.created_at)}</span>
              </p>
              <div
                className={`playback-stage camera-${selected.camera_kind}`}
                // Fit the stage to the clip (portrait phone clips included), within sensible bounds.
                style={aspect ? { aspectRatio: String(Math.min(16 / 9, Math.max(9 / 16, aspect))) } : undefined}
              >
                {clipUrl && store && store.cameras.find((item) => item.id === selected.camera_id) && (
                  <LiveScan
                    key={clipUrl}
                    src={clipUrl}
                    camera={store.cameras.find((item) => item.id === selected.camera_id)!}
                    zones={store.zones}
                    rules={rules ?? []}
                    controls
                    onScan={noteScan}
                    onAspect={setAspect}
                  />
                )}
                {!clipUrl && selected.clip_ref && <p className="playback-empty">Loading the demo clip…</p>}
                {!clipUrl && !selected.clip_ref && (
                  <p className="playback-empty">
                    The clip isn’t kept on our servers, and this device has no copy of it. Clips you investigate here
                    stay on this device for 24 hours; demo clips (demo mode) always play.
                  </p>
                )}
              </div>
              {selected.clip_ref && clipUrl && (
                <p className="muted small">Demo clip · analysed once by Gemini; this is its stored result.</p>
              )}
              {local.expiresAt && <p className="muted small">{localClipNote(local.expiresAt)}</p>}
              {clipUrl ? (
                <>
                  <p>{scan.at(-1)?.detail ?? "Scanning this clip…"}</p>
                  <div className="play-track" aria-label="Scan timeline">
                    {scan.map((reading, index) => {
                      const span = Math.max(6, ...scan.map((item) => item.t), 1);
                      return (
                        <span
                          key={`${reading.t}-${index}`}
                          className="play-mark tone-danger"
                          style={{ left: `${Math.min(92, (reading.t / span) * 100)}%`, width: "6%" }}
                          title={`${clipStamp(reading.t)} ${reading.detail}`}
                        />
                      );
                    })}
                  </div>
                  <ul className="playback-events">
                    {scan.map((reading, index) => (
                      <li key={`${reading.t}-${index}`}>
                        <time>{clipStamp(reading.t)}</time> {reading.detail}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <>
                  <p>{selected.verdict.reason}</p>
                  <Timeline incident={selected} />
                  <ul className="playback-events">
                    {(selected.verdict.timeline ?? []).map((event, index) => (
                      <li key={`${event.t}-${index}`}>
                        <time>{event.t}</time> {event.event}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <Link href={`/incident?id=${encodeURIComponent(selected.id)}`} className="btn btn-primary">
                Open the incident
              </Link>
            </>
          )}
        </section>
      </div>
    </>
  );
}
