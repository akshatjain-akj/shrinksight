/**
 * One Euro filter (Casiez et al.): smooths jittery landmarks when still, but follows fast movement with little lag.
 * The cutoff frequency rises with speed, so a hand darting to a pocket isn't delayed.
 */

import type { PoseLandmark } from "./privacy.ts";

const alpha = (cutoffHz: number, dtS: number) => 1 / (1 + 1 / (2 * Math.PI * cutoffHz * dtS));

export class OneEuroFilter {
  private x: number | null = null;
  private dx = 0;
  private lastMs: number | null = null;
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;

  constructor(minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  filter(value: number, tMs: number): number {
    if (this.x === null || this.lastMs === null || tMs <= this.lastMs) {
      this.x = value;
      this.lastMs = tMs;
      return value;
    }
    const dt = (tMs - this.lastMs) / 1000;
    this.lastMs = tMs;
    const rawDx = (value - this.x) / dt;
    this.dx += alpha(this.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

interface Slot {
  filters: OneEuroFilter[];
  centre: { x: number; y: number };
  seenMs: number;
}

const centreOf = (pose: PoseLandmark[]) => {
  const core = [11, 12, 23, 24].map((i) => pose[i]).filter(Boolean);
  const pts = core.length ? core : pose;
  return { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
};

/**
 * Smooths every landmark of every person. Poses arrive unordered, so each one is matched to the nearest person seen
 * in the previous frames; people not seen for a second are forgotten.
 */
export class PoseSmoother {
  private slots: Slot[] = [];
  private minCutoff: number;
  private beta: number;

  constructor(minCutoff = 1.0, beta = 0.007) {
    this.minCutoff = minCutoff;
    this.beta = beta;
  }

  smooth(poses: PoseLandmark[][], tMs: number): PoseLandmark[][] {
    this.slots = this.slots.filter((s) => tMs - s.seenMs < 1000);
    const free = new Set(this.slots);
    return poses.map((pose) => {
      const centre = centreOf(pose);
      let best: Slot | null = null;
      let bestDist = 0.25;
      for (const slot of free) {
        const d = Math.hypot(slot.centre.x - centre.x, slot.centre.y - centre.y);
        if (d < bestDist) {
          best = slot;
          bestDist = d;
        }
      }
      if (!best) {
        best = { filters: [], centre, seenMs: tMs };
        this.slots.push(best);
      }
      free.delete(best);
      best.centre = centre;
      best.seenMs = tMs;
      const slot = best;
      return pose.map((p, i) => {
        slot.filters[2 * i] ??= new OneEuroFilter(this.minCutoff, this.beta);
        slot.filters[2 * i + 1] ??= new OneEuroFilter(this.minCutoff, this.beta);
        return { ...p, x: slot.filters[2 * i].filter(p.x, tMs), y: slot.filters[2 * i + 1].filter(p.y, tMs) };
      });
    });
  }
}
