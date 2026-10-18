/**
 * Tier-1 threat trigger. MediaPipe can't recognise a gun, but it can see the gesture: an arm held out straight at
 * shoulder height (one-handed), or both hands together out in front at shoulder height (two-handed aim), held for a
 * moment. The object detector adds knives and bats next to a hand. Either sends the clip at once; Gemini decides
 * whether a weapon is actually there. Pointing at a shelf will sometimes trigger it, which is fine: Gemini filters.
 */

import { dist, type Pt } from "./geometry.ts";
import { torsoLength, type BodySample } from "./engine.ts";

/** A detected object, box in 0–1 frame units. */
export interface SeenObject {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type AimSide = "left" | "right" | "both";

/** Hold the pose this long before it counts (a passing gesture doesn't). */
export const AIM_HOLD_MS = 700;
/** After a threat send, wait this long before sending another for the same person. */
export const THREAT_COOLDOWN_MS = 8000;
/** COCO labels the on-device detector knows that count as a weapon in a hand. */
export const WEAPON_LABELS: Record<string, "knife" | "other_weapon"> = { knife: "knife", "baseball bat": "other_weapon" };

function cosAt(vertex: Pt, a: Pt, b: Pt): number {
  const ax = a.x - vertex.x;
  const ay = a.y - vertex.y;
  const bx = b.x - vertex.x;
  const by = b.y - vertex.y;
  const len = Math.hypot(ax, ay) * Math.hypot(bx, by);
  return len ? (ax * bx + ay * by) / len : 1;
}

function armOut(shoulder: Pt | null | undefined, elbow: Pt | null | undefined, wrist: Pt | null | undefined, torso: number): boolean {
  if (!shoulder || !wrist) return false;
  const level = Math.abs(wrist.y - shoulder.y) <= 0.3 * torso;
  const sideways = Math.abs(wrist.x - shoulder.x) >= 0.45 * torso;
  const long = dist(shoulder, wrist) >= 0.6 * torso;
  if (!(level && sideways && long)) return false;
  if (!elbow) return dist(shoulder, wrist) >= 0.75 * torso; // no elbow seen: ask for a longer reach instead
  const straight = cosAt(elbow, shoulder, wrist) <= -0.85; // about 150° or straighter
  const elbowLevel = Math.abs(elbow.y - shoulder.y) <= 0.35 * torso;
  return straight && elbowLevel;
}

/** Which arm is held out in an aiming pose in this frame, if any. Needs shoulders and hips to know the body size. */
export function aimingArm(sample: BodySample): AimSide | null {
  const torso = torsoLength(sample);
  if (!torso || torso < 0.02) return null;
  const { leftShoulder: ls, rightShoulder: rs, leftWrist: lw, rightWrist: rw } = sample;
  // Two-handed: wrists together, at shoulder height, out in front of the body.
  if (ls && rs && lw && rw && dist(lw, rw) <= 0.25 * torso) {
    const shoulders = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
    const hands = { x: (lw.x + rw.x) / 2, y: (lw.y + rw.y) / 2 };
    if (Math.abs(hands.y - shoulders.y) <= 0.3 * torso && Math.abs(hands.x - shoulders.x) >= 0.45 * torso) return "both";
  }
  if (armOut(ls, sample.leftElbow, lw, torso)) return "left";
  if (armOut(rs, sample.rightElbow, rw, torso)) return "right";
  return null;
}

/** A knife or bat whose box (a little enlarged) contains a wrist. */
export function weaponInHand(sample: BodySample, objects: SeenObject[] | undefined): SeenObject | null {
  const wrists = [sample.leftWrist, sample.rightWrist].filter((p): p is Pt => Boolean(p));
  for (const object of objects ?? []) {
    if (!WEAPON_LABELS[object.label]) continue;
    const pad = 0.04;
    if (wrists.some((w) => w.x >= object.x - pad && w.x <= object.x + object.w + pad && w.y >= object.y - pad && w.y <= object.y + object.h + pad)) {
      return object;
    }
  }
  return null;
}

/** Per person: turns frames into at most one threat signal per cooldown. */
export class ThreatWatch {
  private aimSince: number | null = null;
  private cooldownUntil = Number.NEGATIVE_INFINITY;

  /**
   * kinds: what the active rules watch for. Returns the reason to send now, or null. A firearm rule watches the aiming
   * pose; a knife rule watches knives in a hand (and the pose, since a knife can be held out too).
   */
  update(sample: BodySample, kinds: Set<string>, objects?: SeenObject[]): string | null {
    if (!kinds.size || !sample.present) {
      this.aimSince = null;
      return null;
    }
    const side = aimingArm(sample);
    this.aimSince = side ? (this.aimSince ?? sample.tMs) : null;
    const held = this.aimSince !== null && sample.tMs - this.aimSince >= AIM_HOLD_MS;
    const weapon = kinds.has("knife") || kinds.has("any_weapon") ? weaponInHand(sample, objects) : null;
    if (sample.tMs < this.cooldownUntil || (!held && !weapon)) return null;
    this.cooldownUntil = sample.tMs + THREAT_COOLDOWN_MS;
    if (weapon) return `A ${weapon.label} is next to a hand. Gemini checks for a weapon.`;
    const how = side === "both" ? "Both hands held out together at shoulder height" : "Arm held out straight at shoulder height";
    return `${how} (possible aiming). Gemini checks for a weapon.`;
  }
}
