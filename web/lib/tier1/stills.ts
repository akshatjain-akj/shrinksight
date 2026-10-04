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
