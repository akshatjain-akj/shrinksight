import { dist, type Pt } from "./geometry.ts";
import { DEFAULT_TUNING, Tier1Engine, type BodySample, type EdgeTuning, type TickResult } from "./engine.ts";

const MATCH_DIST = 0.18;
const MATCH_MS = 1000;
/** Keep a lost track long enough for a lane-leave decision (1.5s after the person is gone). */
const KEEP_MS = 4000;

export interface SeenPerson {
  hip: Pt;
  sample: BodySample;
  box: [number, number, number, number] | null;
}

interface Track {
  id: number;
  hip: Pt;
  lastT: number;
  engine: Tier1Engine;
  box: [number, number, number, number] | null;
  lastTick: TickResult | null;
}

export class PersonTracker {
  private tracks: Track[] = [];
  private nextId = 1;
  private laneLeave = false;
  private watchHealth = true;
  private tuning: EdgeTuning = DEFAULT_TUNING;
  private readonly makeEngine: () => Tier1Engine;

  constructor(makeEngine: () => Tier1Engine) {
    this.makeEngine = makeEngine;
  }

  setLaneLeave(enabled: boolean): void {
    this.laneLeave = enabled;
    for (const track of this.tracks) track.engine.alwaysCheckTill = enabled;
  }

  /** Applies a re-tuned gate to every tracked person now and to people who appear later. */
  setTuning(tuning: EdgeTuning): void {
    this.tuning = tuning;
    for (const track of this.tracks) track.engine.tuning = tuning;
  }

  setWatchHealth(enabled: boolean): void {
    this.watchHealth = enabled;
    for (const track of this.tracks) track.engine.watchHealth = enabled;
  }

  update(people: SeenPerson[], tMs: number): { tick: TickResult; boxes: { id: number; box: [number, number, number, number] }[]; activeId: number | null } {
    const used = new Set<number>();
    for (const person of people) {
      const track = this.match(person.hip, tMs, used) ?? this.spawn(person.hip, tMs);
      used.add(track.id);
      track.hip = person.hip;
      track.lastT = tMs;
      track.box = person.box;
      track.lastTick = track.engine.tick({ ...person.sample, tMs, box: person.box });
    }
    for (const track of this.tracks) {
      if (used.has(track.id) || tMs - track.lastT > KEEP_MS) continue;
      const absent = track.engine.tick({ tMs, present: false, box: track.box });
      // A duplicate pose can vanish while the shopper is still in frame. That is not a lane exit.
      if (people.length > 0 && absent.hits.some((hit) => hit.kind === "LANE_CLEAR")) {
        track.lastTick = { ...absent, shouldSend: false, reason: "" };
      } else {
        track.lastTick = absent;
      }
    }
    this.tracks = this.tracks.filter((track) => tMs - track.lastT <= KEEP_MS);

    let best: Track | null = null;
    for (const track of this.tracks) {
      const tick = track.lastTick;
      if (!tick) continue;
      if (!best || this.hotter(tick, best.lastTick)) best = track;
    }
    const tick = best?.lastTick ?? PersonTracker.empty();
    return {
      tick,
      activeId: best?.id ?? null,
      boxes: this.tracks.flatMap((track) => (used.has(track.id) && track.box ? [{ id: track.id, box: track.box }] : [])),
    };
  }

  noteSent(tMs: number, activeId: number | null): void {
    const track = this.tracks.find((item) => item.id === activeId) ?? this.tracks[0];
    track?.engine.noteSent(tMs);
  }

  private match(hip: Pt, tMs: number, used: Set<number>): Track | null {
    let best: Track | null = null;
    let bestD = MATCH_DIST;
    for (const track of this.tracks) {
      if (used.has(track.id) || tMs - track.lastT > MATCH_MS) continue;
      const gap = dist(hip, track.hip);
      if (gap < bestD) {
        best = track;
        bestD = gap;
      }
    }
    return best;
  }

  private spawn(hip: Pt, tMs: number): Track {
    const engine = this.makeEngine();
    engine.alwaysCheckTill = this.laneLeave;
    engine.watchHealth = this.watchHealth;
    engine.tuning = this.tuning;
    const track: Track = { id: this.nextId++, hip, lastT: tMs, engine, box: null, lastTick: null };
    this.tracks.push(track);
    return track;
  }

  private hotter(next: TickResult, prev: TickResult | null): boolean {
    if (!prev) return true;
    if (next.shouldSend !== prev.shouldSend) return next.shouldSend;
    return next.smoothed > prev.smoothed;
  }

  private static empty(): TickResult {
    return {
      score: 0,
      smoothed: 0,
      hotFrames: 0,
      shouldSend: false,
      reason: "",
      hits: [],
      dwellSeconds: {},
      laneOccupied: false,
      reachAtMs: null,
      holdAtMs: null,
    };
  }
}
