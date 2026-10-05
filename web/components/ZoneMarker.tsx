"use client";

import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { saveLayoutForEveryone } from "@/lib/cameraConfig";
import type { Frame } from "@/lib/frames";
import type { Pt, ZoneShape } from "@/lib/tier1/geometry";
import { applySuggestions, shapesToHints, ZONE_COLOURS, ZONE_LABELS } from "@/lib/tier1/zones";
import type { Camera } from "@/lib/types";
import { ErrorNotice, Spinner } from "./ui";

const clamp = (n: number) => Math.max(0, Math.min(1, n));

export interface ZoneState {
  shapes: ZoneShape[];
  descriptions: Record<string, string>;
  /** Zones that were really placed (saved, suggested or dragged). Unmarked presets are never sent or saved. */
  marked: string[];
  /** Send the zones with this clip. Off until the boxes are real (saved, suggested or adjusted). */
  send: boolean;
  /** True when the boxes match the camera's saved layout. */
  saved: boolean;
}

export const markedShapes = (state: ZoneState) => state.shapes.filter((s) => state.marked.includes(s.id));

/** Shows a frame of the clip with the camera's zones; drag corners, ask Gemini, save for the camera. */
export default function ZoneMarker({
  camera,
  frame,
  frameError,
  state,
  onChange,
}: {
  camera: Camera;
  frame: Frame | null;
  frameError: string | null;
  state: ZoneState;
  onChange: (next: ZoneState) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [busy, setBusy] = useState<"suggest" | "save" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = state.shapes.find((s) => s.id === selectedId) ?? state.shapes[0];

  const update = (patch: Partial<ZoneState>) => onChange({ ...state, saved: false, send: true, ...patch });

  const movePoint = (index: number, event: React.PointerEvent) => {
    const stage = stageRef.current;
    if (!stage || !selected) return;
    const box = stage.getBoundingClientRect();
    const point: Pt = { x: clamp((event.clientX - box.left) / box.width), y: clamp((event.clientY - box.top) / box.height) };
    update({
      shapes: state.shapes.map((s) =>
        s.id === selected.id ? { ...s, polygon: s.polygon.map((p, i) => (i === index ? point : p)) } : s,
      ),
      marked: state.marked.includes(selected.id) ? state.marked : [...state.marked, selected.id],
    });
  };

  const suggest = async () => {
    if (!frame) return;
    setBusy("suggest");
    setError(null);
    setMessage(null);
    try {
      const res = await api.suggestZones(camera.id, frame.blob);
      const out = applySuggestions(state.shapes, state.descriptions, res.zones);
      update({
        shapes: out.shapes,
        descriptions: out.descriptions,
        marked: [...new Set([...state.marked, ...out.found])],
      });
      const names = (ids: string[]) => ids.map((id) => state.shapes.find((s) => s.id === id)?.name ?? id).join(", ");
      setMessage(
        out.found.length
          ? `Gemini placed: ${names(out.found)}.${out.missing.length ? ` Not found: ${names(out.missing)}. Drag those yourself.` : ""} Check and adjust.`
          : "Gemini couldn’t find the zones in this frame. Drag the corners yourself.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy("save");
    setError(null);
    setMessage(null);
    try {
      await saveLayoutForEveryone(camera.id, markedShapes(state), state.descriptions);
      onChange({ ...state, saved: true, send: true });
      setMessage(`Saved as the layout for ${camera.name}. Everyone using this camera now gets these zones.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const copyForEval = async () => {
    const json = JSON.stringify(shapesToHints(markedShapes(state), state.descriptions), null, 2);
    try {
      await navigator.clipboard.writeText(json);
      setMessage("Zones copied. Paste them as \"zones\" for this clip in eval/manifest.json.");
    } catch {
      setError("Couldn’t copy to the clipboard in this browser.");
    }
  };

  return (
    <div className="stack">
      {frameError && <ErrorNotice>{frameError}</ErrorNotice>}
      {!frame && !frameError && <Spinner label="Reading the first frame…" />}
      {frame && selected && (
        <>
          <div ref={stageRef} className="zone-stage" style={{ aspectRatio: `${frame.width} / ${frame.height}` }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={frame.dataUrl} alt={`First frame of the clip for ${camera.name}`} />
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              {state.shapes.map((shape) => (
                <polygon
                  key={shape.id}
                  points={shape.polygon.map((p) => `${p.x * 100},${p.y * 100}`).join(" ")}
                  className={shape.id === selected.id ? "zone-poly is-active" : "zone-poly"}
                  style={{
                    stroke: ZONE_COLOURS[shape.kind],
                    fill: `${ZONE_COLOURS[shape.kind]}22`,
                    opacity: state.marked.includes(shape.id) || shape.id === selected.id ? 1 : 0.35,
                  }}
                  onClick={() => setSelectedId(shape.id)}
                />
              ))}
              {selected.polygon.map((point, index) => (
                <circle
                  key={index}
                  cx={point.x * 100}
                  cy={point.y * 100}
                  r="1.8"
                  className="zone-handle"
                  style={{ fill: ZONE_COLOURS[selected.kind] }}
                  onPointerDown={(event) => {
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setDrag(index);
                  }}
                  onPointerMove={(event) => drag === index && movePoint(index, event)}
                  onPointerUp={() => setDrag(null)}
                />
              ))}
            </svg>
            {state.shapes.map((shape) => {
              const top = shape.polygon.reduce((best, p) => (p.y < best.y ? p : best), shape.polygon[0]);
              return (
                <span
                  key={shape.id}
                  className="zone-tag"
                  style={{ left: `${top.x * 100}%`, top: `${top.y * 100}%`, background: ZONE_COLOURS[shape.kind] }}
                >
                  {ZONE_LABELS[shape.kind] ?? shape.kind}
                </span>
              );
            })}
          </div>

          <div className="row" role="group" aria-label="Zone to edit">
            {state.shapes.map((shape) => (
              <button
                key={shape.id}
                type="button"
                className="chip"
                aria-pressed={shape.id === selected.id}
                onClick={() => setSelectedId(shape.id)}
              >
                <span aria-hidden="true" style={{ color: ZONE_COLOURS[shape.kind] }}>■</span> {shape.name}
                {!state.marked.includes(shape.id) && <span className="muted"> · not marked</span>}
              </button>
            ))}
          </div>
          <div className="field">
            <label htmlFor={`zone-desc-${selected.id}`}>What does the {selected.name.toLowerCase()} look like?</label>
            <input
              id={`zone-desc-${selected.id}`}
              type="text"
              maxLength={120}
              placeholder={selected.kind === "scanner" ? "e.g. white paper square on the counter" : "e.g. brown box at the right"}
              value={state.descriptions[selected.id] ?? ""}
              onChange={(e) => update({ descriptions: { ...state.descriptions, [selected.id]: e.target.value } })}
            />
            <span className="hint">
              Drag the coloured corners onto the real area. A short description helps Gemini too. Only zones you mark
              are used{selected.kind === "pickup" ? "; the item pile is optional but helps Gemini count every item" : ""}.
            </span>
          </div>

          <div className="row">
            <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={suggest}>
              {busy === "suggest" ? "Asking Gemini…" : "✨ Suggest zones with Gemini"}
            </button>
            <button type="button" className="btn" disabled={busy !== null || state.saved} onClick={save}>
              {busy === "save" ? "Saving…" : state.saved ? "✓ Camera layout" : "Save as this camera’s layout"}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={copyForEval}>
              Copy zones for eval
            </button>
          </div>
          <label className="row" style={{ fontWeight: 400 }}>
            <input type="checkbox" checked={state.send} onChange={(e) => onChange({ ...state, send: e.target.checked })} />
            <span className="small">
              Send these zones with this clip
              {!state.saved && state.send ? " (for this clip only until you save them)" : ""}
            </span>
          </label>
          {message && (
            <div className="notice" role="status">
              {message}
            </div>
          )}
          {error && <ErrorNotice>{error}</ErrorNotice>}
        </>
      )}
    </div>
  );
}
