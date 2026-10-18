/** People from MediaPipe pose landmarks, in the form the Tier-1 tracker reads. Shared by Live edge and Investigate. */

import { personBox, type Pt } from "./geometry.ts";
import type { SeenPerson } from "./tracks.ts";

export type Landmark = { x: number; y: number; visibility?: number };

/** One entry per real person: duplicate poses on the same body are dropped, the biggest box wins. */
export function posePeople(poses: Landmark[][], tMs: number): SeenPerson[] {
  const people = poses.flatMap((pose) => {
    const visible = (i: number): Pt | null => {
      const p = pose[i];
      const min = i === 15 || i === 16 ? 0.35 : 0.5;
      if (!p || (p.visibility ?? 0) < min) return null;
      return { x: p.x, y: p.y };
    };
    const points = pose.filter((p) => (p.visibility ?? 0) >= 0.5).map((p) => ({ x: p.x, y: p.y }));
    const leftHip = visible(23);
    const rightHip = visible(24);
    const shoulder = visible(11) ?? visible(12);
    const hip = leftHip && rightHip
      ? { x: (leftHip.x + rightHip.x) / 2, y: (leftHip.y + rightHip.y) / 2 }
      : leftHip ?? rightHip;
    if (!hip || !shoulder || points.length < 8) return [];
    const box = personBox(points);
    return [{
      hip,
      box,
      sample: {
        tMs,
        present: true,
        leftWrist: visible(15),
        rightWrist: visible(16),
        leftHip,
        rightHip,
        leftShoulder: visible(11),
        rightShoulder: visible(12),
        leftElbow: visible(13),
        rightElbow: visible(14),
        box,
      },
    }];
  });
  const kept: typeof people = [];
  const ranked = [...people].sort((a, b) => boxArea(b.box) - boxArea(a.box));
  for (const person of ranked) {
    if (kept.some((other) => Math.hypot(other.hip.x - person.hip.x, other.hip.y - person.hip.y) < 0.22)) continue;
    kept.push(person);
  }
  return kept;
}

export function boxArea(box: [number, number, number, number] | null): number {
  if (!box) return 0;
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
}
