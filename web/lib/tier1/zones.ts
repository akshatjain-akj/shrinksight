/** Zone helpers shared by the zone marker, the Investigate stills and Live edge recordings. */

import type { Pt, ZoneShape } from "./geometry.ts";
import type { ZoneHint, ZoneSuggestion } from "../types.ts";

export const ZONE_COLOURS: Record<string, string> = {
  pickup: "#f472b6",
  scanner: "#fbbf24",
  bagging: "#38bdf8",
  shelf: "#34d399",
  exit: "#c084fc",
};

export const ZONE_LABELS: Record<string, string> = {
  pickup: "ITEMS",
  scanner: "SCANNER",
  bagging: "BAGGING",
  shelf: "SHELF",
  exit: "EXIT",
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Gemini's [ymin, xmin, ymax, xmax] (0–1000) to a normalised rectangle polygon. */
export function boxToPolygon(box: number[]): Pt[] {
  const [ymin, xmin, ymax, xmax] = box.map((n) => clamp01(n / 1000));
  return [
    { x: xmin, y: ymin },
    { x: xmax, y: ymin },
    { x: xmax, y: ymax },
    { x: xmin, y: ymax },
  ];
}

export function shapesToHints(shapes: ZoneShape[], descriptions: Record<string, string> = {}): ZoneHint[] {
  return shapes
    .filter((shape) => shape.polygon.length >= 3)
    .map((shape) => ({
      zone_id: shape.id,
      kind: shape.kind as ZoneHint["kind"],
      polygon: shape.polygon.map((p) => ({ x: round3(clamp01(p.x)), y: round3(clamp01(p.y)) })),
      description: (descriptions[shape.id] ?? "").slice(0, 120),
    }));
}

/**
 * Applies zones saved with a demo clip (possibly marked on another camera) to this camera's shapes: matched by zone
 * id, else by kind. Returns the ids that were placed.
 */
export function applyHints(
  shapes: ZoneShape[],
  descriptions: Record<string, string>,
  hints: ZoneHint[],
): { shapes: ZoneShape[]; descriptions: Record<string, string>; placed: string[] } {
  const unused = [...hints];
  const placed: string[] = [];
  const nextDescriptions = { ...descriptions };
  const next = shapes.map((shape) => {
    const index = unused.findIndex((h) => h.zone_id === shape.id);
    const at = index >= 0 ? index : unused.findIndex((h) => h.kind === shape.kind);
    if (at < 0 || (unused[at].polygon?.length ?? 0) < 3) return shape;
    const [hint] = unused.splice(at, 1);
    placed.push(shape.id);
    if (hint.description) nextDescriptions[shape.id] = hint.description;
    return { ...shape, polygon: hint.polygon.map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) })) };
  });
  return { shapes: next, descriptions: nextDescriptions, placed };
}

/** Applies Gemini's suggestions: found zones get the suggested box and description; others keep their shape. */
export function applySuggestions(
  shapes: ZoneShape[],
  descriptions: Record<string, string>,
  suggestions: ZoneSuggestion[],
): { shapes: ZoneShape[]; descriptions: Record<string, string>; found: string[]; missing: string[] } {
  const byId = new Map(suggestions.map((s) => [s.zone_id, s]));
  const found: string[] = [];
  const missing: string[] = [];
  const nextDescriptions = { ...descriptions };
  const next = shapes.map((shape) => {
    const s = byId.get(shape.id);
    if (!s || !s.found || s.box_2d.length !== 4) {
      missing.push(shape.id);
      return shape;
    }
    found.push(shape.id);
    if (s.description) nextDescriptions[shape.id] = s.description;
    return { ...shape, polygon: boxToPolygon(s.box_2d) };
  });
  return { shapes: next, descriptions: nextDescriptions, found, missing };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Draws labelled zone outlines. `toCanvas` maps a normalised point to canvas pixels, so the same function
 * works on letterboxed Live edge frames and on full-frame stills.
 */
export function drawZoneOutlines(
  ctx: CanvasRenderingContext2D,
  shapes: ZoneShape[],
  toCanvas: (p: Pt) => [number, number],
  scale = 1,
): void {
  ctx.save();
  ctx.lineWidth = Math.max(2, 3 * scale);
  ctx.font = `700 ${Math.max(11, Math.round(14 * scale))}px system-ui, sans-serif`;
  ctx.textBaseline = "bottom";
  for (const shape of shapes) {
    if (shape.polygon.length < 3) continue;
    const colour = ZONE_COLOURS[shape.kind] ?? "#e6ebf5";
    ctx.strokeStyle = colour;
    ctx.setLineDash([10 * scale, 6 * scale]);
    ctx.beginPath();
    shape.polygon.forEach((p, i) => {
      const [x, y] = toCanvas(p);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    const top = shape.polygon.reduce((best, p) => (p.y < best.y || (p.y === best.y && p.x < best.x) ? p : best));
    const [lx, ly] = toCanvas(top);
    const label = ZONE_LABELS[shape.kind] ?? shape.kind.toUpperCase();
    const pad = 4 * scale;
    const width = ctx.measureText(label).width + pad * 2;
    const height = Math.max(11, 14 * scale) + pad;
    ctx.fillStyle = colour;
    ctx.fillRect(lx, Math.max(0, ly - height), width, height);
    ctx.fillStyle = "#0b1220";
    ctx.fillText(label, lx + pad, Math.max(height, ly) - pad / 2);
  }
  ctx.restore();
}

/** A normalised rectangle (0–1). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The part of the frame worth sending: the marked zones plus a 30% margin. Returns null when there are no zones or
 * the crop would keep most of the frame anyway (then cropping gains nothing).
 */
export function actionCrop(zones: ZoneShape[], padding = 0.3, maxArea = 0.7): Rect | null {
  const points = zones.flatMap((z) => z.polygon);
  if (!points.length) return null;
  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxY = Math.max(...points.map((p) => p.y));
  const padX = (maxX - minX) * padding;
  const padY = (maxY - minY) * padding;
  const x = clamp01(minX - padX);
  const y = clamp01(minY - padY);
  const w = clamp01(maxX + padX) - x;
  const h = clamp01(maxY + padY) - y;
  if (w * h > maxArea || w < 0.05 || h < 0.05) return null;
  return { x: round3(x), y: round3(y), w: round3(w), h: round3(h) };
}

/** [ymin, xmin, ymax, xmax] on Gemini's 0–1000 grid. */
export function rectToBox(r: Rect): [number, number, number, number] {
  return [Math.round(r.y * 1000), Math.round(r.x * 1000), Math.round((r.y + r.h) * 1000), Math.round((r.x + r.w) * 1000)];
}
