"use client";

import { useState } from "react";
import { ErrorNotice, Skeletons } from "@/components/ui";
import { api } from "@/lib/api";
import { useStore } from "@/lib/hooks";
import type { Zone } from "@/lib/types";

const KINDS: { id: Zone["kind"]; label: string }[] = [
  { id: "pickup", label: "Item pile" },
  { id: "scanner", label: "Scanner" },
  { id: "bagging", label: "Bagging" },
  { id: "shelf", label: "Shelf" },
  { id: "exit", label: "Exit" },
];

export default function ZoneConfig() {
  const { store, error: storeError, reload } = useStore();
  const [name, setName] = useState("");
  const [cameraId, setCameraId] = useState("");
  const [kind, setKind] = useState<Zone["kind"]>("shelf");
  const [highValue, setHighValue] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cameras = store?.cameras ?? [];
  const zones = store?.zones ?? [];
  const selectedCamera = cameraId || cameras[0]?.id || "";

  const add = async () => {
    setError(null);
    setBusy("add");
    try {
      await api.createZone({
        name: name.trim(),
        camera_id: selectedCamera,
        kind,
        high_value: highValue,
      });
      setName("");
      setHighValue(false);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the zone");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (zone: Zone) => {
    setError(null);
    setBusy(zone.id);
    try {
      await api.deleteZone(zone.id);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the zone");
    } finally {
      setBusy(null);
    }
  };

  if (storeError && !store) return <ErrorNotice>{storeError}</ErrorNotice>;
  if (!store) return <Skeletons count={3} />;

  return (
    <section className="settings-card" aria-label="Zone configuration">
      <header className="settings-card-head">
        <div>
          <h2>Zones</h2>
          <p className="hint">A zone is a spot inside one camera. Rules attach to the zone, not the camera.</p>
        </div>
      </header>
      <form
        className="zone-form"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <label>
          Zone name
          <input value={name} maxLength={80} placeholder="Spirits shelf" onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          Camera
          <select value={selectedCamera} onChange={(event) => setCameraId(event.target.value)}>
            {cameras.map((camera) => (
              <option key={camera.id} value={camera.id}>
                {camera.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Kind
          <select value={kind} onChange={(event) => setKind(event.target.value as Zone["kind"])}>
            {KINDS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="zone-check">
          <input type="checkbox" checked={highValue} onChange={(event) => setHighValue(event.target.checked)} />
          High value
        </label>
        <button type="submit" className="btn btn-primary" disabled={name.trim().length < 2 || !selectedCamera || busy === "add"}>
          {busy === "add" ? "Adding…" : "Add zone"}
        </button>
      </form>
      {error && (
        <div className="role-note">
          <ErrorNotice>{error}</ErrorNotice>
        </div>
      )}
      <ul className="zone-list">
        {cameras.map((camera) => {
          const rows = zones.filter((zone) => zone.camera_id === camera.id);
          return (
            <li key={camera.id}>
              <p className="zone-camera">
                <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 8h11a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
                  <path d="M16 11.5l4-2.2v7.4l-4-2.2z" />
                </svg>
                {camera.name}
              </p>
              {rows.length === 0 && <p className="hint">No zones on this camera.</p>}
              <ul>
                {rows.map((zone) => (
                  <li key={zone.id}>
                    <span>
                      <strong>{zone.name}</strong>
                      <span className="muted small">{KINDS.find((item) => item.id === zone.kind)?.label}</span>
                      {zone.high_value && <span className="chip tone-warning">High value</span>}
                    </span>
                    <button type="button" className="btn btn-sm" disabled={busy === zone.id} onClick={() => void remove(zone)}>
                      {busy === zone.id ? "Deleting…" : "Delete"}
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
