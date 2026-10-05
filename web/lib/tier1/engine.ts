import { dist, inAny, type Pt, type ZoneShape } from "./geometry.ts";
import type { Rule } from "../types.ts";

export interface BodySample {
  /** Milliseconds since the watch started. */
  tMs: number;
  present: boolean;
  leftWrist?: Pt | null;
  rightWrist?: Pt | null;
  leftHip?: Pt | null;
  rightHip?: Pt | null;
  leftShoulder?: Pt | null;
  rightShoulder?: Pt | null;
  /** [ymin, xmin, ymax, xmax] in 0–1000, when a body is in frame. */
  box?: [number, number, number, number] | null;
}

export interface Tier1Hit {
  t: string;
  kind: "SCANNER_BYPASS" | "CONCEALMENT" | "SHELF_REACH" | "PUT_BACK" | "HEALTH_HAZARD" | "DWELL" | "ZONE_ENTRY" | "LANE_CLEAR";
  score: number;
  detail: string;
  trigger?: "hot_score" | "lane_leave";
  confidence?: number;
  box?: [number, number, number, number];
  camera_id?: string;
}

export interface TickResult {
  score: number;
  smoothed: number;
  hotFrames: number;
  shouldSend: boolean;
  reason: string;
  hits: Tier1Hit[];
  dwellSeconds: Record<string, number>;
  laneOccupied: boolean;
  /** Last shelf reach, and when the hide hold started. Null when that moment has not happened. */
  reachAtMs: number | null;
  holdAtMs: number | null;
}

/**
 * How strict the gate is before a clip goes to Gemini. The server auto-tunes it per camera from the false-alarm
 * rate (edge_config in Firestore) and the browser applies changes live.
 */
export interface EdgeTuning {
  /** Smoothed score that counts as a hot frame. */
  sendScore: number;
  /** Consecutive hot frames needed to send. */
  hotFrames: number;
  /** Added to the concealment hold time. */
  holdExtraMs: number;
}

export const DEFAULT_TUNING: EdgeTuning = { sendScore: 0.4, hotFrames: 8, holdExtraMs: 0 };

type HideSpot = "pocket" | "bag" | "shirt" | "waistband";

const HIDE_DETAIL: Record<HideSpot, string> = {
  pocket: "Item went from a reach into a jacket pocket",
  bag: "Item went from a reach into a bag at the side",
  shirt: "Item was tucked under the shirt",
  waistband: "Item was slid into the waistband",
};
const COOLDOWN_MS = 20_000;

function nearest(point: Pt, points: Pt[]): Pt | null {
  if (!points.length) return null;
  return points.reduce((best, candidate) => (dist(candidate, point) < dist(best, point) ? candidate : best));
}

function stamp(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${String(m).padStart(2, "0")}:${rem.toFixed(1).padStart(4, "0")}`;
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Overnight windows (21:00–06:00) wrap past midnight. */
export function ruleActive(rule: Rule, now: Date): boolean {
  if (!rule.enabled || !rule.spec.supported) return false;
  const { active_from: from, active_to: to } = rule.spec;
  if (!from || !to) return true;
  const nowM = now.getHours() * 60 + now.getMinutes();
  const a = minutes(from);
  const b = minutes(to);
  return a <= b ? nowM >= a && nowM < b : nowM >= a || nowM < b;
}

export class Tier1Engine {
  private readonly cameraKind: "checkout" | "floor";
  private readonly zones: ZoneShape[];
  private readonly rules: Rule[];
  private readonly clock: () => Date;
  private smoothed = 0;
  private hotFrames = 0;
  private cooldownUntil = 0;
  private poseTrail: BodySample[] = [];
  private concealSince: number | null = null;
  private concealSpot: HideSpot | null = null;
  private reachSeenAt: number | null = null;
  /** True once the hand has left the shelf after a reach, so the next reach is a put-back. */
  private handLeftShelf = false;
  /** Only the wrist that actually entered the shelf can be a hide. A hanging arm is not. */
  private reachedSide = { left: false, right: false };
  /** Show the put-back line until this time. A returned item is not a hide. */
  private putBackUntil = 0;
  /** When the torso first went flat on the floor. A bend toward a shelf does not start this. */
  private downSince: number | null = null;
  private dwellMs: Record<string, number> = {};
  private lastT = 0;
  private inside = new Set<string>();
  private occupiedSince: number | null = null;
  private absentSince: number | null = null;
  private laneWasOccupied = false;
  private sawSignal = false;
  private sentLane = false;
  /** Checkout only: after a real hit, send when the shopper leaves the lane. */
  alwaysCheckTill = false;
  /** Camera setting. Off skips the person-down check. */
  watchHealth = true;
  /** The camera's gate strictness; updated live when the server re-tunes it. */
  tuning: EdgeTuning = DEFAULT_TUNING;

  constructor(
    cameraKind: "checkout" | "floor",
    zones: ZoneShape[],
    rules: Rule[],
    clock: () => Date = () => new Date(),
  ) {
    this.cameraKind = cameraKind;
    this.zones = zones;
    this.rules = rules;
    this.clock = clock;
  }

  /** Call after a clip has been handed to Gemini so the same moment is not sent twice. */
  noteSent(tMs: number): void {
    this.hotFrames = 0;
    this.smoothed = 0;
    this.cooldownUntil = tMs + COOLDOWN_MS;
    this.sentLane = true;
  }

  tick(sample: BodySample): TickResult {
    const dt = this.lastT ? Math.min(500, Math.max(0, sample.tMs - this.lastT)) : 0;
    this.lastT = sample.tMs;
    const hits: Tier1Hit[] = [];
    let raw = 0;

    this.poseTrail.push(sample);
    this.poseTrail = this.poseTrail.filter((s) => sample.tMs - s.tMs <= 2000);

    const wrists = [sample.leftWrist, sample.rightWrist].filter((p): p is Pt => Boolean(p));
    const hips = [sample.leftHip, sample.rightHip].filter((p): p is Pt => Boolean(p));
    const anchor = hips[0] ?? wrists[0] ?? null;

    if (sample.present && anchor) {
      this.occupiedSince ??= sample.tMs;
      this.absentSince = null;
      this.laneWasOccupied = sample.tMs - this.occupiedSince > 2000;
    } else if (this.laneWasOccupied) {
      this.absentSince ??= sample.tMs;
    }

    if (this.cameraKind === "checkout" && this.bypass(wrists)) {
      raw = Math.max(raw, 0.72);
      this.sawSignal = true;
      hits.push({
        t: stamp(sample.tMs),
        kind: "SCANNER_BYPASS",
        score: 0.72,
        detail: "Hand reached the bagging area without crossing the scanner",
      });
    }

    const down = this.personDown(sample);
    const conceal = down ? false : this.concealment(sample);
    if (down) {
      raw = Math.max(raw, 0.82);
      this.sawSignal = true;
      hits.push({
        t: stamp(sample.tMs),
        kind: "HEALTH_HAZARD",
        score: 0.82,
        detail: "Person is down on the floor. Possible medical emergency.",
      });
    } else if (conceal) {
      raw = Math.max(raw, 0.7);
      this.sawSignal = true;
      hits.push({
        t: stamp(sample.tMs),
        kind: "CONCEALMENT",
        score: 0.7,
        detail: HIDE_DETAIL[this.concealSpot ?? "pocket"],
      });
    } else if (sample.tMs <= this.putBackUntil) {
      raw = Math.max(raw, 0.3);
      hits.push({
        t: stamp(sample.tMs),
        kind: "PUT_BACK",
        score: 0.3,
        detail: "Item put back on the shelf.",
      });
    } else if (
      this.cameraKind === "floor" &&
      this.reachSeenAt !== null &&
      sample.tMs - this.reachSeenAt <= 2000
    ) {
      raw = Math.max(raw, 0.55);
      this.sawSignal = true;
      hits.push({
        t: stamp(sample.tMs),
        kind: "SHELF_REACH",
        score: 0.55,
        detail: "Hand reached into the shelf. Gemini checks where the item went.",
      });
    }

    const now = this.clock();
    for (const rule of this.rules) {
      if (!ruleActive(rule, now) || !rule.spec.zone_id) continue;
      const zone = this.zones.find((z) => z.id === rule.spec.zone_id);
      if (!zone || !anchor) continue;
      const inside = hips.some((hip) => inAny(hip, [zone]));
      if (rule.spec.type === "DWELL") {
        this.dwellMs[zone.id] = inside ? (this.dwellMs[zone.id] ?? 0) + dt : 0;
        const need = (rule.spec.min_seconds ?? 45) * 1000;
        if ((this.dwellMs[zone.id] ?? 0) >= need) {
          raw = Math.max(raw, 0.66);
          this.sawSignal = true;
          hits.push({
            t: stamp(sample.tMs),
            kind: "DWELL",
            score: 0.66,
            detail: rule.spec.summary,
          });
        }
      }
      if (rule.spec.type === "ZONE_ENTRY") {
        const was = this.inside.has(zone.id);
        if (inside && !was) {
          raw = Math.max(raw, 0.6);
          this.sawSignal = true;
          hits.push({
            t: stamp(sample.tMs),
            kind: "ZONE_ENTRY",
            score: 0.6,
            detail: rule.spec.summary,
          });
        }
        if (inside) this.inside.add(zone.id);
        else this.inside.delete(zone.id);
      }
    }

    this.smoothed = this.smoothed * 0.55 + raw * 0.45;
    if (this.smoothed >= this.tuning.sendScore) this.hotFrames += 1;
    else this.hotFrames = 0;

    let shouldSend = this.hotFrames >= this.tuning.hotFrames && sample.tMs >= this.cooldownUntil;
    let reason = shouldSend ? "Score stayed high across consecutive frames" : "";

    const cleared =
      this.cameraKind === "checkout" &&
      this.laneWasOccupied &&
      this.absentSince !== null &&
      sample.tMs - this.absentSince > 1500 &&
      !this.sentLane;
    if (!shouldSend && cleared && this.sawSignal && this.alwaysCheckTill && sample.tMs >= this.cooldownUntil) {
      shouldSend = true;
      reason = "Shopper left the lane after a signal";
      hits.push({
        t: stamp(sample.tMs),
        kind: "LANE_CLEAR",
        score: this.smoothed,
        detail: "Checkout session closed after a real signal. The till cross-check needs the whole window.",
      });
    }

    const dwellSeconds: Record<string, number> = {};
    for (const [id, ms] of Object.entries(this.dwellMs)) dwellSeconds[id] = Math.round(ms / 100) / 10;

    const trigger: Tier1Hit["trigger"] = reason.startsWith("Shopper left") ? "lane_leave" : "hot_score";
    const confidence = Math.round(this.smoothed * 100) / 100;
    const visible = (shouldSend || raw > 0 ? hits.slice(-4) : []).map((hit) => ({
      ...hit,
      ...(shouldSend ? { trigger: hit.kind === "LANE_CLEAR" ? "lane_leave" as const : trigger } : {}),
      confidence,
      ...(sample.box ? { box: sample.box } : {}),
    }));

    return {
      score: raw,
      smoothed: this.smoothed,
      hotFrames: this.hotFrames,
      shouldSend,
      reason,
      hits: visible,
      dwellSeconds,
      laneOccupied: this.occupiedSince !== null && this.absentSince === null,
      reachAtMs: this.reachSeenAt,
      holdAtMs: this.concealSince,
    };
  }

  private trailWrists(): { tMs: number; p: Pt }[] {
    const out: { tMs: number; p: Pt }[] = [];
    for (const sample of this.poseTrail) {
      if (sample.leftWrist) out.push({ tMs: sample.tMs, p: sample.leftWrist });
      if (sample.rightWrist) out.push({ tMs: sample.tMs, p: sample.rightWrist });
    }
    return out;
  }

  private bypass(wrists: Pt[]): boolean {
    const scanner = this.zones.filter((z) => z.kind === "scanner");
    const bagging = this.zones.filter((z) => z.kind === "bagging");
    const trail = this.trailWrists();
    if (!scanner.length || !bagging.length || trail.length < 4) return false;
    const inBag = wrists.some((w) => inAny(w, bagging));
    if (!inBag) return false;
    const scanned = trail.filter((w) => inAny(w.p, scanner)).length;
    const approached = trail.some((w) => !inAny(w.p, scanner) && !inAny(w.p, bagging));
    return approached && scanned / trail.length < 0.2;
  }

  /** Average each wrist over the last half second so one bad frame does not count. */
  private withSmoothedWrists(sample: BodySample): BodySample {
    const recent = this.poseTrail.filter((frame) => sample.tMs - frame.tMs <= 500 && frame.tMs <= sample.tMs);
    const mean = (pick: (frame: BodySample) => Pt | null | undefined): Pt | null => {
      const points = recent.map(pick).filter((point): point is Pt => Boolean(point));
      if (!points.length) return null;
      return {
        x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
        y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
      };
    };
    return {
      ...sample,
      leftWrist: mean((frame) => frame.leftWrist) ?? sample.leftWrist,
      rightWrist: mean((frame) => frame.rightWrist) ?? sample.rightWrist,
    };
  }

  private reaching(sample: BodySample, shelf: ZoneShape[]): boolean {
    if (!shelf.length) return false;
    const smooth = this.withSmoothedWrists(sample);
    const hips = [sample.leftHip, sample.rightHip].filter((p): p is Pt => Boolean(p));
    const shoulder = sample.leftShoulder ?? sample.rightShoulder;
    const hands: Array<[Pt | null | undefined, Pt | null | undefined]> = [
      [sample.leftWrist, smooth.leftWrist],
      [sample.rightWrist, smooth.rightWrist],
    ];
    return hands.some(([raw, wrist]) => {
      if (!raw || !wrist || !inAny(raw, shelf) || !inAny(wrist, shelf)) return false;
      const extended = (point: Pt) => {
        const hip = nearest(point, hips);
        const away = hip ? dist(point, hip) > 0.2 : false;
        const lifted = shoulder ? point.y < shoulder.y - 0.02 : false;
        return away || lifted;
      };
      return extended(raw) && extended(wrist);
    });
  }

  /** A hand back in front of the body, not in clothing. That is a basket, not a hide. */
  private basket(sample: BodySample): boolean {
    const wrists = [sample.leftWrist, sample.rightWrist].filter((p): p is Pt => Boolean(p));
    const hips = [sample.leftHip, sample.rightHip].filter((p): p is Pt => Boolean(p));
    return wrists.some((wrist) => {
      const hip = nearest(wrist, hips);
      if (!hip) return false;
      const gap = dist(wrist, hip);
      return gap > 0.16 && gap < 0.24 && Math.abs(wrist.y - hip.y) < 0.1;
    });
  }

  /** Raw wrist on the shelf and stretched out. Smoothing is not required, so a put-back counts immediately. */
  private rawOnShelf(wrist: Pt, sample: BodySample, shelf: ZoneShape[]): boolean {
    if (!shelf.length || !inAny(wrist, shelf)) return false;
    const hips = [sample.leftHip, sample.rightHip].filter((p): p is Pt => Boolean(p));
    const hip = nearest(wrist, hips);
    const away = hip ? dist(wrist, hip) > 0.2 : false;
    const shoulder = sample.leftShoulder ?? sample.rightShoulder;
    const lifted = shoulder ? wrist.y < shoulder.y - 0.02 : false;
    return away || lifted;
  }

  /** Where a hand settled after a reach. Pocket, bag, shirt, and waistband are separate rules. */
  private hideSpot(sample: BodySample, shelf: ZoneShape[]): HideSpot | null {
    const wrists = [
      this.reachedSide.left ? sample.leftWrist : null,
      this.reachedSide.right ? sample.rightWrist : null,
    ].filter((p): p is Pt => Boolean(p));
    const hips = [sample.leftHip, sample.rightHip].filter((p): p is Pt => Boolean(p));
    const shoulders = [sample.leftShoulder, sample.rightShoulder].filter((p): p is Pt => Boolean(p));
    const shoulder = shoulders[0];
    const midX = shoulders.length
      ? shoulders.reduce((sum, point) => sum + point.x, 0) / shoulders.length
      : hips[0]?.x;
    for (const wrist of wrists) {
      const hip = nearest(wrist, hips);
      if (!hip) continue;
      const dx = Math.abs(wrist.x - hip.x);
      const gap = dist(wrist, hip);
      if (this.hideAllowed("waistband") && wrist.y > hip.y + 0.05 && dx < 0.12) return "waistband";
      if (
        this.hideAllowed("shirt") &&
        shoulder &&
        midX !== undefined &&
        Math.abs(wrist.x - midX) < 0.08 &&
        wrist.y > shoulder.y + 0.05 &&
        wrist.y < hip.y - 0.12
      ) {
        return "shirt";
      }
      if (this.hideAllowed("pocket") && dx < 0.12 && wrist.y > hip.y - 0.16 && wrist.y <= hip.y + 0.04) return "pocket";
      if (this.hideAllowed("pocket") && gap < 0.16) return "pocket";
      if (this.hideAllowed("bag") && shoulder && !inAny(wrist, shelf) && gap > 0.22 && gap < 0.48 && wrist.y >= shoulder.y && wrist.y <= hip.y + 0.1) {
        return "bag";
      }
    }
    return null;
  }

  private hideAllowed(spot: HideSpot): boolean {
    const named = this.rules
      .filter((rule) => rule.enabled && rule.spec.type === "CONCEALMENT_SENSITIVITY" && rule.spec.concealment_of)
      .map((rule) => rule.spec.concealment_of);
    return named.length === 0 || named.includes(spot);
  }

  private concealment(sample: BodySample): boolean {
    if (this.cameraKind !== "floor") return false;
    const shelf = this.zones.filter((z) => z.kind === "shelf");
    const window = this.poseTrail.filter((s) => sample.tMs - s.tMs <= 2000 && s.present);
    if (window.length < 3) return false;
    if (sample.leftWrist && this.rawOnShelf(sample.leftWrist, sample, shelf)) this.reachedSide.left = true;
    if (sample.rightWrist && this.rawOnShelf(sample.rightWrist, sample, shelf)) this.reachedSide.right = true;
    const reaches = window.filter((frame) => this.reaching(frame, shelf));
    if (reaches.length) this.reachSeenAt = reaches[reaches.length - 1].tMs;
    const recent = window.filter((s) => sample.tMs - s.tMs <= 500);
    if (!recent.length) return false;
    const smoothed = recent.map((frame) => this.withSmoothedWrists(frame));
    if (smoothed.filter((frame) => this.basket(frame)).length / smoothed.length >= 0.6) {
      this.concealSince = null;
      this.concealSpot = null;
      return false;
    }
    const handOnShelf = Boolean(
      (sample.leftWrist && this.reachedSide.left && this.rawOnShelf(sample.leftWrist, sample, shelf)) ||
        (sample.rightWrist && this.reachedSide.right && this.rawOnShelf(sample.rightWrist, sample, shelf)),
    );
    if (handOnShelf && !this.hideSpot(sample, shelf)) {
      if (this.handLeftShelf) {
        this.putBackUntil = sample.tMs + 2500;
        this.handLeftShelf = false;
      }
      this.reachSeenAt = sample.tMs;
      this.concealSince = null;
      this.concealSpot = null;
      return false;
    }
    const recentReaches = recent.filter((frame) => this.reaching(frame, shelf) && !this.hideSpot(frame, shelf));
    if (recentReaches.length) {
      if (this.handLeftShelf) {
        this.putBackUntil = sample.tMs + 2500;
        this.handLeftShelf = false;
      }
      this.reachSeenAt = recentReaches[recentReaches.length - 1].tMs;
      this.concealSince = null;
      this.concealSpot = null;
      return false;
    }
    if (this.reachSeenAt !== null && sample.tMs - this.reachSeenAt > 400) this.handLeftShelf = true;
    const spots = smoothed.map((frame) => this.hideSpot(frame, shelf)).filter((spot): spot is HideSpot => Boolean(spot));
    const spot = spots.sort((a, b) => spots.filter((item) => item === b).length - spots.filter((item) => item === a).length)[0];
    const hideRatio = spot ? spots.filter((item) => item === spot).length / recent.length : 0;
    const recentReach = this.reachSeenAt !== null && sample.tMs - this.reachSeenAt < 3000;
    if (hideRatio >= 0.6 && recentReach && spot) {
      this.concealSince ??= sample.tMs;
      this.concealSpot = spot;
    } else if (hideRatio < 0.3) {
      this.concealSince = null;
      this.concealSpot = null;
    }
    const hold = this.sensitivityMs();
    return this.concealSince !== null && sample.tMs - this.concealSince >= hold;
  }

  /** Torso flat and low in the frame. A shopper bent over a shelf stays upright enough to miss this. */
  private personDown(sample: BodySample): boolean {
    if (!this.watchHealth || !sample.present) {
      this.downSince = null;
      return false;
    }
    const shoulders = [sample.leftShoulder, sample.rightShoulder].filter((point): point is Pt => Boolean(point));
    const hips = [sample.leftHip, sample.rightHip].filter((point): point is Pt => Boolean(point));
    if (!shoulders.length || !hips.length) {
      this.downSince = null;
      return false;
    }
    const shoulder = {
      x: shoulders.reduce((sum, point) => sum + point.x, 0) / shoulders.length,
      y: shoulders.reduce((sum, point) => sum + point.y, 0) / shoulders.length,
    };
    const hip = {
      x: hips.reduce((sum, point) => sum + point.x, 0) / hips.length,
      y: hips.reduce((sum, point) => sum + point.y, 0) / hips.length,
    };
    const rise = hip.y - shoulder.y;
    const flat = rise < 0.1 && Math.abs(hip.x - shoulder.x) > 0.18;
    const onFloor = Math.max(shoulder.y, hip.y) > 0.62;
    if (flat && onFloor) this.downSince ??= sample.tMs;
    else this.downSince = null;
    return this.downSince !== null && sample.tMs - this.downSince >= 1000;
  }

  private sensitivityMs(): number {
    const rule = this.rules.find((r) => r.enabled && r.spec.type === "CONCEALMENT_SENSITIVITY");
    const base = rule?.spec.sensitivity === "high" ? 800 : rule?.spec.sensitivity === "low" ? 1800 : 1200;
    return base + this.tuning.holdExtraMs;
  }
}
