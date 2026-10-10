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
const clampPt = (p: Pt): Pt => ({ x: clamp(p.x), y: clamp(p.y) });

/** What a pointer drag is doing: moving the whole zone, one corner, or one side (index = the side's first corner). */
interface Drag {
  pointerId: number;
  mode: "move" | "corner" | "edge";
  index: number;
  zoneId: string;
  start: Pt;
  polygon: Pt[];
  /** False until the pointer has really moved, so a tap only selects the zone. */
  moved: boolean;
}

/** The zone's polygon after a drag from drag.start to `to`. Stage size is needed so a side moves at a right angle. */
function dragged(drag: Drag, to: Pt, width: number, height: number): Pt[] {
  const { polygon, start } = drag;
  if (drag.mode === "corner") return polygon.map((p, i) => (i === drag.index ? clampPt(to) : p));
  if (drag.mode === "move") {
    const xs = polygon.map((p) => p.x);
    const ys = polygon.map((p) => p.y);
    const dx = Math.max(-Math.min(...xs), Math.min(1 - Math.max(...xs), to.x - start.x));
    const dy = Math.max(-Math.min(...ys), Math.min(1 - Math.max(...ys), to.y - start.y));
    return polygon.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  }
  const i = drag.index;
  const j = (i + 1) % polygon.length;
  const ex = (polygon[j].x - polygon[i].x) * width;
  const ey = (polygon[j].y - polygon[i].y) * height;
  const len = Math.hypot(ex, ey) || 1;
  const nx = -ey / len;
  const ny = ex / len;
  const along = (to.x - start.x) * width * nx + (to.y - start.y) * height * ny;
  const off = { x: (nx * along) / width, y: (ny * along) / height };
  return polygon.map((p, k) => (k === i || k === j ? clampPt({ x: p.x + off.x, y: p.y + off.y }) : p));
}

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

/** Shows a frame of the clip with the camera's zones; drag zones, corners and sides, ask Gemini, save for the camera. */
export default function ZoneMarker({
  camera,
  clipUrl,
  frame,
  frameError,
  state,
  onChange,
}: {
  camera: Camera;
  /** The clip itself: shown under the zones when the browser couldn't draw a still of it. */
  clipUrl: string;
  frame: Frame | null;
  frameError: string | null;
  state: ZoneState;
  onChange: (next: ZoneState) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<"suggest" | "save" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = state.shapes.find((s) => s.id === selectedId) ?? state.shapes[0];

  const update = (patch: Partial<ZoneState>) => onChange({ ...state, saved: false, send: true, ...patch });

  const setPolygon = (zoneId: string, polygon: Pt[]) =>
    update({
      shapes: state.shapes.map((s) => (s.id === zoneId ? { ...s, polygon } : s)),
      marked: state.marked.includes(zoneId) ? state.marked : [...state.marked, zoneId],
    });

  const pointAt = (event: React.PointerEvent): Pt | null => {
    const box = stageRef.current?.getBoundingClientRect();
    if (!box) return null;
    return { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height };
  };

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || dragRef.current) return;
    const target = event.target as Element;
    const handle = target.closest<HTMLElement>("[data-handle]");
    const zoneId = handle ? selected?.id : target.closest("[data-zone]")?.getAttribute("data-zone");
    const shape = state.shapes.find((s) => s.id === zoneId);
    const start = pointAt(event);
    if (!shape || !start) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedId(shape.id);
    dragRef.current = {
      pointerId: event.pointerId,
      mode: handle ? (handle.dataset.handle as "corner" | "edge") : "move",
      index: Number(handle?.dataset.index ?? 0),
      zoneId: shape.id,
      start,
      polygon: shape.polygon,
      moved: false,
    };
    setDragging(true);
  };

  const moveDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const box = stageRef.current?.getBoundingClientRect();
    const to = pointAt(event);
    if (!drag || drag.pointerId !== event.pointerId || !box || !to) return;
    if (!drag.moved) {
      if (Math.hypot((to.x - drag.start.x) * box.width, (to.y - drag.start.y) * box.height) < 4) return;
      drag.moved = true;
    }
    setPolygon(drag.zoneId, dragged(drag, to, box.width, box.height));
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
  };

  // Arrow keys nudge the selected zone; Shift moves it further.
  const nudge = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.02 : 0.005;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta || !selected) return;
    event.preventDefault();
    const drag: Drag = { pointerId: -1, mode: "move", index: 0, zoneId: selected.id, start: { x: 0, y: 0 }, polygon: selected.polygon, moved: true };
    setPolygon(selected.id, dragged(drag, { x: delta[0], y: delta[1] }, 1, 1));
  };

  const suggest = async () => {
    if (!frame || frame.blank) return;
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
      const pileMissing = state.shapes.some((s) => s.kind === "pickup" && out.missing.includes(s.id));
      setMessage(
        (out.found.length
          ? `Gemini placed: ${names(out.found)}.${out.missing.length ? ` Not found: ${names(out.missing)}. Drag those yourself.` : ""} Check and adjust.`
          : "Gemini couldn’t find the zones in this frame. Drag them into place yourself.") +
          (pileMissing ? " Please mark the item pile: its close-up is how Gemini counts every item, even flat ones." : ""),
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
          <div
            ref={stageRef}
            className={dragging ? "zone-stage is-dragging" : "zone-stage"}
            style={{ aspectRatio: `${frame.width} / ${frame.height}` }}
            tabIndex={0}
            aria-label={`Zones on the first frame of the clip for ${camera.name}. Arrow keys move the ${selected.name.toLowerCase()}.`}
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={nudge}
          >
            {frame.blank ? (
              <video
                src={`${clipUrl}#t=${frame.time}`}
                muted
                playsInline
                preload="auto"
                onLoadedMetadata={(event) => {
                  event.currentTarget.currentTime = frame.time;
                }}
                aria-hidden="true"
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={frame.dataUrl} alt="" draggable={false} />
            )}
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              {/* The selected zone is drawn last so it stays grabbable where zones overlap. */}
              {[...state.shapes.filter((s) => s.id !== selected.id), selected].map((shape) => (
                <polygon
                  key={shape.id}
                  data-zone={shape.id}
                  points={shape.polygon.map((p) => `${p.x * 100},${p.y * 100}`).join(" ")}
                  className={shape.id === selected.id ? "zone-poly is-active" : "zone-poly"}
                  style={{
                    stroke: ZONE_COLOURS[shape.kind],
                    fill: `${ZONE_COLOURS[shape.kind]}22`,
                    opacity: state.marked.includes(shape.id) || shape.id === selected.id ? 1 : 0.35,
                  }}
                />
              ))}
            </svg>
            {selected.polygon.map((point, index) => {
              const next = selected.polygon[(index + 1) % selected.polygon.length];
              const angle = Math.atan2((next.y - point.y) * frame.height, (next.x - point.x) * frame.width);
              return (
                <span
                  key={`edge-${index}`}
                  data-handle="edge"
                  data-index={index}
                  className="zone-handle zone-handle-edge"
                  style={{
                    left: `${((point.x + next.x) / 2) * 100}%`,
                    top: `${((point.y + next.y) / 2) * 100}%`,
                    background: ZONE_COLOURS[selected.kind],
                    transform: `translate(-50%, -50%) rotate(${angle}rad)`,
                  }}
                />
              );
            })}
            {selected.polygon.map((point, index) => (
              <span
                key={`corner-${index}`}
                data-handle="corner"
                data-index={index}
                className="zone-handle"
                style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%`, background: ZONE_COLOURS[selected.kind] }}
              />
            ))}
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
              Drag a zone to move it, its corners to reshape it, or the middle of a side to stretch it. A short
              description helps Gemini too. Only zones you mark
              are used{selected.kind === "pickup" ? "; the item pile is optional but helps Gemini count every item" : ""}.
            </span>
          </div>

          <div className="row">
            <button type="button" className="btn btn-primary" disabled={busy !== null || frame.blank} onClick={suggest}>
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
          {frame.blank && (
            <p className="muted small" style={{ margin: 0 }}>
              Gemini suggest isn’t available for this clip format. Drag the zones yourself.
            </p>
          )}
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
