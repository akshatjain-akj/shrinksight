/**
 * Tier-1 screening of a whole uploaded clip: the same tracker, engines and gate as Live edge, fed frame by frame.
 *
 * Live edge runs pose about every other video frame and ticks the engines on every frame, so the gate's
 * "hot frames" count assumes ~30 ticks a second. Here each pose sample (every SAMPLE_MS of clip time) is ticked
 * TICKS_PER_SAMPLE times at evenly spaced times, which keeps the gate as strict as it is live.
 */

import type { Tier1Hit, TickResult } from "./engine.ts";
import type { PersonTracker, SeenPerson } from "./tracks.ts";

export const SAMPLE_MS = 100;
export const TICKS_PER_SAMPLE = 3;
const MAX_HINTS = 8;

export interface ScreenResult {
  /** True when the camera's gate opened somewhere in the clip. */
  flagged: boolean;
  /** Clip time (ms) the gate first opened, and why. */
  openedAtMs: number | null;
  reason: string;
  /** Strongest distinct signals, clip-relative, for Gemini's hints (also shown when the clip was cleared). */
  hits: Tier1Hit[];
  peakScore: number;
  /** Fraction of samples with a person in view. */
  personSeen: number;
  /** Shelf reach and hide-hold times around the first opening (or the last ones seen), clip ms. */
  reachAtMs: number | null;
  holdAtMs: number | null;
}

/** Feeds pose samples through a tracker and remembers what the gate did. */
export class ClipScreen {
  private readonly tracker: Pick<PersonTracker, "update">;
  private flagged = false;
  private openedAtMs: number | null = null;
  private reason = "";
  private peak = 0;
  private samples = 0;
  private withPerson = 0;
  private hits = new Map<string, Tier1Hit>();
  private reachAtMs: number | null = null;
  private holdAtMs: number | null = null;

  constructor(tracker: Pick<PersonTracker, "update">) {
    this.tracker = tracker;
  }

  /** One pose sample at clip time tMs. */
  feed(tMs: number, people: SeenPerson[]): void {
    this.samples += 1;
    if (people.length) this.withPerson += 1;
    const step = SAMPLE_MS / TICKS_PER_SAMPLE;
    for (let i = 0; i < TICKS_PER_SAMPLE; i += 1) {
      const t = tMs + i * step;
      this.take(this.tracker.update(people, t).tick, t);
    }
  }

  result(): ScreenResult {
    const hits = [...this.hits.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_HINTS)
      .sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0))
      .map(({ atMs: _atMs, ...hit }) => hit);
    return {
      flagged: this.flagged,
      openedAtMs: this.openedAtMs,
      reason: this.reason,
      hits,
      peakScore: Math.round(this.peak * 100) / 100,
      personSeen: this.samples ? this.withPerson / this.samples : 0,
      reachAtMs: this.reachAtMs,
      holdAtMs: this.holdAtMs,
    };
  }

  private take(tick: TickResult, tMs: number): void {
    this.peak = Math.max(this.peak, tick.smoothed);
    if (!this.flagged) {
      // Before the gate opens keep the latest moments; after, keep the ones that opened it.
      this.reachAtMs = tick.reachAtMs ?? this.reachAtMs;
      this.holdAtMs = tick.holdAtMs ?? this.holdAtMs;
    }
    if (tick.shouldSend && !this.flagged) {
      this.flagged = true;
      this.openedAtMs = tMs;
      this.reason = tick.reason;
    }
    for (const hit of tick.hits) {
      if (hit.kind === "LANE_CLEAR" && !this.flagged) continue;
      const key = `${hit.kind}@${Math.round((hit.atMs ?? 0) / 1000)}`;
      const seen = this.hits.get(key);
      // Same signal in the same second: keep the moment the gate was most sure of it.
      if (!seen || (hit.confidence ?? hit.score) > (seen.confidence ?? seen.score)) this.hits.set(key, hit);
    }
  }
}
