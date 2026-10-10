"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import GeminiMarks from "@/components/GeminiMarks";
import LiveScan from "@/components/LiveScan";
import { ErrorNotice, Skeletons } from "@/components/ui";
import { VERDICT_LABEL, clipSeconds } from "@/lib/format";
import { useIncidents, useRules, useStore } from "@/lib/hooks";
import { useDemoClipUrl } from "@/lib/useClip";
import { flaggedItem } from "@/lib/marks";
import { fitPlayer } from "@/lib/player";
import {
  forDemoMode,
  useDemoIncidents,
  useDemoMode,
  useSightings,
  withDemoIncidents,
  withSightings,
} from "@/lib/demoMode";
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

function Timeline({ incident, onSeek }: { incident: Incident; onSeek?: (t: string) => void }) {
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
          <button
            type="button"
            key={`${event.t}-${index}`}
            className={`play-mark tone-${markColor(event.event, incident.verdict.verdict)}`}
            style={{ left: `${Math.min(92, at * 100)}%`, width: "6%" }}
            title={`${event.t} ${event.event}`}
            aria-label={`Jump to ${event.t}: ${event.event}`}
            onClick={() => onSeek?.(event.t)}
            disabled={!onSeek}
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
  const sightings = useSightings();
  // Demo clips' results are often older than the newest-50 incident window, so they are fetched on their own.
  const demoIncidents = useDemoIncidents(demoOn);
  const [showAllDemo, setShowAllDemo] = useState(false);
  // Demo mode: a demo clip's incident is "recorded" once the Monitor wall has flagged it this session (alerting
  // verdicts only), dated when it appeared. "Show all demo results" lists every analysed demo clip instead.
  const listed = useMemo(() => {
    if (!allIncidents) return null;
    if (!demoOn) return { items: forDemoMode(allIncidents, false), seenAt: new Map<string, number>() };
    const everything = withDemoIncidents(allIncidents, demoIncidents);
    if (showAllDemo) return { items: everything, seenAt: new Map<string, number>() };
    return withSightings(everything, sightings);
  }, [allIncidents, demoOn, showAllDemo, sightings, demoIncidents]);
  const incidents = listed?.items ?? null;
  const when = (incident: Incident) => {
    const seen = listed?.seenAt.get(incident.id);
    return seen ? new Date(seen).toISOString() : incident.created_at;
  };
  const unseenDemo =
    demoOn && !showAllDemo && demoIncidents.length > 0 && !listed?.seenAt.size;
  const [range, setRange] = useState<Range>("24h");
  const [cameraId, setCameraId] = useState("all");
  const [eventType, setEventType] = useState<EventFilter>("all");
  const [applied, setApplied] = useState({ range: "24h" as Range, cameraId: "all", eventType: "all" as EventFilter });
  const [picked, setPicked] = useState<string | null>(null);
  // The playing clip's time and element: Gemini's boxes follow it and the timeline seeks it.
  const [playhead, setPlayhead] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
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
    setPlayhead(null);
    setAspect(null);
  }, [selected?.id]);

  const focus = selected ? flaggedItem(selected.verdict.seen_items) : null;
  const seek = (t: string) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = clipSeconds(t);
    video.pause();
    setPlayhead(video.currentTime);
  };

  // On a phone the player sits above the results: picking one brings the player back into view.
  const pick = (id: string) => {
    setPicked(id);
    if (!window.matchMedia("(max-width: 900px)").matches) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    playerRef.current?.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
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
          {unseenDemo && (
            <p className="hint">
              Demo recordings appear here once their clip flags on the <Link href="/monitor">Monitor</Link>.{" "}
              <button type="button" className="linkish" onClick={() => setShowAllDemo(true)}>
                Show all demo results
              </button>
            </p>
          )}
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
                  {clock(when(incident))} · {incident.camera_name}
                  {listed?.seenAt.has(incident.id) ? " · demo, just now" : ""}
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
                <span className="muted"> · {clock(when(selected))}</span>
              </p>
              <div
                className={`playback-stage camera-${selected.camera_kind}`}
                // The stage takes the clip's exact shape (portrait included), so overlays line up with no blank space.
                style={fitPlayer(aspect)}
              >
                {clipUrl && store && store.cameras.find((item) => item.id === selected.camera_id) && (
                  <LiveScan
                    key={clipUrl}
                    src={clipUrl}
                    camera={store.cameras.find((item) => item.id === selected.camera_id)!}
                    zones={store.zones}
                    rules={rules ?? []}
                    controls
                    scoreOnly
                    savedZones={selected.zones_used}
                    onTime={setPlayhead}
                    onVideo={(video) => {
                      videoRef.current = video;
                    }}
                    onAspect={setAspect}
                  />
                )}
                {clipUrl && <GeminiMarks items={selected.verdict.seen_items} focus={focus} playhead={playhead ?? 0} />}
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
              {/* Always the stored Gemini result. Tier-1 on the video only draws; it never decides what is shown here. */}
              <p className="playback-verdict">
                <span className={`chip tone-${markColor("", selected.verdict.verdict) === "danger" ? "danger" : "accent"}`}>
                  {VERDICT_LABEL[selected.verdict.verdict]} {Math.round(selected.verdict.confidence * 100)}%
                </span>{" "}
                <span className="muted small">Gemini’s stored result</span>
              </p>
              <p>{selected.verdict.reason}</p>
              <Timeline incident={selected} onSeek={clipUrl ? seek : undefined} />
              <ul className="playback-events">
                {(selected.verdict.timeline ?? []).map((event, index) => (
                  <li key={`${event.t}-${index}`}>
                    {clipUrl ? (
                      <button type="button" className="linkish" onClick={() => seek(event.t)}>
                        <time>{event.t}</time>
                      </button>
                    ) : (
                      <time>{event.t}</time>
                    )}{" "}
                    {event.event}
                  </li>
                ))}
              </ul>
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
