import { stamp } from "./engine.ts";

export type StillLabel = "before" | "reach" | "hold" | "after";

export interface TimedStill {
  tMs: number;
  blob: Blob;
}

export interface MarkedStill {
  label: StillLabel;
  blob: Blob;
}

const ORDER: StillLabel[] = ["before", "reach", "hold", "after"];

function nearest(shots: TimedStill[], target: number, used: Set<number>): TimedStill | null {
  const open = shots.filter((shot) => !used.has(shot.tMs));
  if (!open.length) return null;
  return open.reduce((best, shot) => (Math.abs(shot.tMs - target) < Math.abs(best.tMs - target) ? shot : best));
}

/** Four distinct stills: before the reach, the reach, the hold, and the latest frame. */
export function pickFour(shots: TimedStill[], reachAtMs: number | null, holdAtMs: number | null): MarkedStill[] {
  if (!shots.length) return [];
  const first = shots[0].tMs;
  const last = shots[shots.length - 1].tMs;
  const span = Math.max(1, last - first);
  const targets = [
    reachAtMs != null ? reachAtMs - 700 : first,
    reachAtMs ?? first + span * 0.33,
    holdAtMs ?? first + span * 0.66,
    last,
  ];
  const used = new Set<number>();
  const picked: MarkedStill[] = [];
  targets.forEach((target, index) => {
    const shot = nearest(shots, target, used);
    if (!shot) return;
    used.add(shot.tMs);
    picked.push({ label: ORDER[index], blob: shot.blob });
  });
  return picked;
}

// ---------- Hand close-ups and clip-relative hints (Live edge) ----------

export type HandLabel = "hand_reach" | "hand_hold";

export interface CropBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A square around the wrists (canvas pixels), padded and kept inside the canvas. Cropped from the face-blurred canvas,
 * so a hand near the face stays blurred. Null when no wrist is visible.
 */
export function handRect(
  points: { x: number; y: number }[],
  width: number,
  height: number,
  minSide = 96,
  pad = 40,
): CropBox | null {
  if (!points.length) return null;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const side = Math.min(Math.max(minSide, span + pad * 2), width, height);
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
  const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  const x = Math.min(Math.max(0, cx - side / 2), width - side);
  const y = Math.min(Math.max(0, cy - side / 2), height - side);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(side), h: Math.round(side) };
}

/** The hand close-ups nearest the reach and the possible hide (each within maxGapMs), never the same shot twice. */
export function pickHands(
  shots: TimedStill[],
  reachAtMs: number | null,
  holdAtMs: number | null,
  maxGapMs = 600,
): { label: HandLabel; blob: Blob }[] {
  const used = new Set<number>();
  const picked: { label: HandLabel; blob: Blob }[] = [];
  const wanted: [HandLabel, number | null][] = [["hand_reach", reachAtMs], ["hand_hold", holdAtMs]];
  for (const [label, at] of wanted) {
    if (at == null) continue;
    const shot = nearest(shots, at, used);
    if (!shot || Math.abs(shot.tMs - at) > maxGapMs) continue;
    used.add(shot.tMs);
    picked.push({ label, blob: shot.blob });
  }
  return picked;
}

/**
 * Moves hint times from "since the webcam started" to "since this clip started", so Gemini is told to look at 00:05.2
 * of a 9-second clip instead of 02:31.4. The internal ms field is dropped.
 */
export function toClipTime<T extends { t: string; atMs?: number }>(hits: T[], clipStartMs: number): Omit<T, "atMs">[] {
  return hits.map(({ atMs, ...hit }) => (atMs == null ? hit : { ...hit, t: stamp(Math.max(0, atMs - clipStartMs)) }));
}
