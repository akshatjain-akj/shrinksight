"use client";

import { useEffect, useRef, useState } from "react";
import { ErrorNotice, Skeletons } from "@/components/ui";
import {
  DEFAULT_DETECTION,
  loadCameraConfigs,
  saveCameraConfig,
  saveLayoutForEveryone,
  savedZoneIds,
  syncLayoutsFromServer,
  type DetectionSwitches,
} from "@/lib/cameraConfig";
import { useStore } from "@/lib/hooks";
import { polygonsFor, type Pt } from "@/lib/tier1/geometry";
import { useClipUrl } from "@/lib/useClip";
import type { Camera } from "@/lib/types";

function clamp(n: number): number {
  return Math.max(0.02, Math.min(0.98, n));
}

export default function CameraConfig({ initialCameraId }: { initialCameraId?: string | null }) {
  const { store, error } = useStore();
  const cameras = store?.cameras ?? [];
  const [cameraId, setCameraId] = useState<string | null>(initialCameraId ?? null);
  const [zoneId, setZoneId] = useState<string | null>(null);
  const [polygons, setPolygons] = useState<Record<string, Pt[]>>({});
  const [detection, setDetection] = useState<DetectionSwitches>(DEFAULT_DETECTION);
  const [editing, setEditing] = useState(true);
  const [drag, setDrag] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Zones that are really placed: saved before, or dragged here. Placeholder presets are never saved.
  const [touched, setTouched] = useState<string[]>([]);
  const [synced, setSynced] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);

  const camera = cameras.find((item) => item.id === cameraId) ?? cameras[0];
  const zones = store && camera ? store.zones.filter((zone) => camera.zone_ids.includes(zone.id)) : [];
  const zone = zones.find((item) => item.id === zoneId) ?? zones[0];
  const clipUrl = useClipUrl(camera?.id ?? null);
  const field = (name: string) => `${name}-${camera?.id ?? "cam"}`;

  useEffect(() => {
    if (initialCameraId) setCameraId(initialCameraId);
  }, [initialCameraId]);

  useEffect(() => {
    let current = true;
    void syncLayoutsFromServer().then(() => current && setSynced((n) => n + 1));
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    if (!camera || !store) return;
    const savedConfig = loadCameraConfigs()[camera.id];
    const shapes = polygonsFor(
      store.zones.filter((item) => camera.zone_ids.includes(item.id)),
      savedConfig?.polygons,
    );
    setPolygons(Object.fromEntries(shapes.map((shape) => [shape.id, shape.polygon])));
    setDetection({ ...DEFAULT_DETECTION, ...savedConfig?.detection });
    setZoneId((current) => (current && camera.zone_ids.includes(current) ? current : shapes[0]?.id ?? null));
    setTouched(savedZoneIds(camera.id));
    setSaved(false);
    setEditing(true);
  }, [camera, store, synced]);

  const points = zone ? polygons[zone.id] ?? [] : [];

  const movePoint = (index: number, event: React.PointerEvent) => {
    const stage = stageRef.current;
    if (!stage || !zone) return;
    const box = stage.getBoundingClientRect();
    const next = points.map((point, i) =>
      i === index
        ? {
            x: clamp((event.clientX - box.left) / box.width),
            y: clamp((event.clientY - box.top) / box.height),
          }
        : point,
    );
    setPolygons((current) => ({ ...current, [zone.id]: next }));
    setTouched((current) => (current.includes(zone.id) ? current : [...current, zone.id]));
    setSaved(false);
  };

  const save = async () => {
    if (!camera) return;
    setSaveError(null);
    const current = loadCameraConfigs()[camera.id];
    const placed = Object.fromEntries(Object.entries(polygons).filter(([id]) => touched.includes(id)));
    saveCameraConfig(camera.id, { ...current, detection, polygons: placed });
    try {
      const shapes = zones
        .filter((item) => touched.includes(item.id))
        .map((item) => ({ id: item.id, name: item.name, kind: item.kind, polygon: polygons[item.id] ?? [] }));
      await saveLayoutForEveryone(camera.id, shapes, current?.descriptions ?? {});
      setSaved(true);
    } catch (e) {
      setSaveError(`Saved on this browser only: ${(e as Error).message}`);
    }
  };

  if (error) return <ErrorNotice>Couldn’t load the store: {error}</ErrorNotice>;
  if (!store) return <Skeletons count={2} />;
  if (!camera || !zone) return null;

  return (
    <section className="settings-card" aria-label="Camera configuration">
      <header className="settings-card-head">
        <h2>Camera configuration</h2>
        <span className="muted small">{camera.name}</span>
      </header>
      <div className="settings-body">
        <div className="settings-stage-wrap">
          <div className="settings-cameras" role="tablist" aria-label="Cameras">
            {cameras.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={item.id === camera.id}
                className={item.id === camera.id ? "is-on" : ""}
                onClick={() => setCameraId(item.id)}
              >
                {item.name}
              </button>
            ))}
          </div>
          <div className="settings-stage" ref={stageRef}>
            {clipUrl ? (
              <video className="settings-video" src={clipUrl} muted autoPlay loop playsInline crossOrigin="anonymous" />
            ) : (
              <StoreScene camera={camera} />
            )}
            <svg className="settings-zone" viewBox="0 0 100 100" preserveAspectRatio="none">
              {zones.map((item) => {
                const poly = polygons[item.id] ?? [];
                const active = item.id === zone.id;
                const d = poly.map((point) => `${point.x * 100},${point.y * 100}`).join(" ");
                return (
                  <polygon
                    key={item.id}
                    points={d}
                    className={active ? "is-active" : ""}
                    onClick={() => {
                      setZoneId(item.id);
                      setEditing(true);
                    }}
                  />
                );
              })}
              {editing &&
                points.map((point, index) => (
                  <circle
                    key={index}
                    cx={point.x * 100}
                    cy={point.y * 100}
                    r="1.6"
                    className="settings-handle"
                    onPointerDown={(event) => {
                      event.currentTarget.setPointerCapture(event.pointerId);
                      setDrag(index);
                    }}
                    onPointerMove={(event) => {
                      if (drag === index) movePoint(index, event);
                    }}
                    onPointerUp={() => setDrag(null)}
                  />
                ))}
            </svg>
            <div className="settings-zone-label">
              <span>{zone.name}</span>
              {editing && (
                <button type="button" className="chip" onClick={() => setEditing(false)}>
                  Done
                </button>
              )}
            </div>
          </div>
          {zones.length > 1 && (
            <label className="settings-zone-pick">
              Zone
              <select value={zone.id} onChange={(event) => setZoneId(event.target.value)}>
                {zones.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="hint">Drag the corners. The saved shape is what Live edge and Monitor use for this camera.</p>
        </div>
        <aside className="settings-rules" aria-label="Detection switches">
          <h2>Detection</h2>
          <Toggle
            id={field("person")}
            label="Person detection"
            checked={detection.person}
            onChange={(person) => {
              setDetection((current) => ({ ...current, person }));
              setSaved(false);
            }}
          />
          <Toggle
            id={field("conceal")}
            label="Concealment detection"
            checked={detection.concealment}
            onChange={(concealment) => {
              setDetection((current) => ({ ...current, concealment }));
              setSaved(false);
            }}
          />
          <Toggle
            id={field("loiter")}
            label="Loitering detection"
            checked={detection.loitering}
            onChange={(loitering) => {
              setDetection((current) => ({ ...current, loitering }));
              setSaved(false);
            }}
          />
          <label className="settings-slider" htmlFor={field("loiter-seconds")}>
            <span>Time threshold {detection.loiterSeconds}s</span>
            <input
              id={field("loiter-seconds")}
              type="range"
              min={10}
              max={120}
              step={5}
              value={detection.loiterSeconds}
              onChange={(event) => {
                setDetection((current) => ({ ...current, loiterSeconds: Number(event.target.value) }));
                setSaved(false);
              }}
            />
          </label>
          <Toggle
            id={field("health")}
            label="Health hazard detection"
            checked={detection.healthHazard}
            onChange={(healthHazard) => {
              setDetection((current) => ({ ...current, healthHazard }));
              setSaved(false);
            }}
          />
          <Toggle
            id={field("reach")}
            label="Shelf-reach check"
            checked={detection.shelfReach}
            onChange={(shelfReach) => {
              setDetection((current) => ({ ...current, shelfReach }));
              setSaved(false);
            }}
          />
          <button type="button" className="btn btn-primary" onClick={save}>
            Save configuration
          </button>
          {saved && <p className="hint">Saved for everyone using this camera.</p>}
          {saveError && <ErrorNotice>{saveError}</ErrorNotice>}
        </aside>
      </div>
    </section>
  );
}

function Toggle({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="settings-toggle" htmlFor={id}>
      <span>{label}</span>
      <input id={id} type="checkbox" role="switch" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function StoreScene({ camera }: { camera: Camera }) {
  const checkout = camera.kind === "checkout";
  return (
    <div className={`settings-scene ${checkout ? "is-checkout" : "is-aisle"}`} aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}
