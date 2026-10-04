/** Normalised image points. Origin is the top-left, both axes run 0–1. */

export interface Pt {
  x: number;
  y: number;
}

export interface ZoneShape {
  id: string;
  name: string;
  kind: string;
  polygon: Pt[];
}

export function rect(x: number, y: number, w: number, h: number): Pt[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

/** Same layout on every camera of a kind, so the overlay matches the rule engine. */
const PRESET: Record<string, Pt[]> = {
  scanner: rect(0.36, 0.42, 0.22, 0.16),
  bagging: rect(0.64, 0.34, 0.28, 0.4),
  shelf: rect(0.08, 0.16, 0.56, 0.58),
  exit: rect(0.72, 0.04, 0.26, 0.92),
};

export function polygonsFor(
  zones: { id: string; name: string; kind: string }[],
  saved?: Record<string, Pt[]>,
): ZoneShape[] {
  return zones.map((zone) => ({
    id: zone.id,
    name: zone.name,
    kind: zone.kind,
    polygon: saved?.[zone.id]?.length ? saved[zone.id] : (PRESET[zone.kind] ?? rect(0.2, 0.2, 0.4, 0.4)),
  }));
}

export function pointInPoly(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const crosses = a.y > p.y !== b.y > p.y;
    const xAtY = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-9) + a.x;
    if (crosses && p.x < xAtY) inside = !inside;
  }
  return inside;
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Axis-aligned body box in the prompt's 0–1000 space: [ymin, xmin, ymax, xmax]. */
export function personBox(points: Pt[]): [number, number, number, number] | null {
  if (!points.length) return null;
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const pad = 0.04;
  const clamp = (n: number) => Math.max(0, Math.min(1000, Math.round(n)));
  const xmin = clamp((minX - pad) * 1000);
  const ymin = clamp((minY - pad) * 1000);
  const xmax = clamp((maxX + pad) * 1000);
  const ymax = clamp((maxY + pad) * 1000);
  if (xmax - xmin < 20 || ymax - ymin < 20) return null;
  return [ymin, xmin, ymax, xmax];
}

export function inAny(p: Pt, zones: ZoneShape[], kind?: string): ZoneShape | null {
  for (const zone of zones) {
    if (kind && zone.kind !== kind) continue;
    if (pointInPoly(p, zone.polygon)) return zone;
  }
  return null;
}
