import assert from "node:assert/strict";
import test from "node:test";
import { Tier1Engine, type BodySample } from "./engine.ts";
import { polygonsFor } from "./geometry.ts";
import { AIM_HOLD_MS, THREAT_COOLDOWN_MS, ThreatWatch, aimingArm, weaponInHand } from "./threat.ts";
import type { Rule } from "../types.ts";

/** A standing person facing the camera: shoulders at y 0.3, hips at y 0.6 (torso 0.3). */
function body(tMs: number, arms: Partial<BodySample> = {}): BodySample {
  return {
    tMs,
    present: true,
    leftShoulder: { x: 0.45, y: 0.3 },
    rightShoulder: { x: 0.55, y: 0.3 },
    leftHip: { x: 0.46, y: 0.6 },
    rightHip: { x: 0.54, y: 0.6 },
    // arms hanging down by default
    leftElbow: { x: 0.44, y: 0.42 },
    rightElbow: { x: 0.56, y: 0.42 },
    leftWrist: { x: 0.44, y: 0.54 },
    rightWrist: { x: 0.56, y: 0.54 },
    ...arms,
  };
}

const rightArmOut = { rightElbow: { x: 0.65, y: 0.3 }, rightWrist: { x: 0.76, y: 0.31 } };
const twoHandAim = { leftWrist: { x: 0.72, y: 0.31 }, rightWrist: { x: 0.75, y: 0.32 }, leftElbow: null, rightElbow: null };

test("an arm held out straight at shoulder height is an aiming pose; arms down are not", () => {
  assert.equal(aimingArm(body(0)), null);
  assert.equal(aimingArm(body(0, rightArmOut)), "right");
  assert.equal(aimingArm(body(0, twoHandAim)), "both");
  // reaching up to a high shelf: wrist far above the shoulder
  assert.equal(aimingArm(body(0, { rightElbow: { x: 0.6, y: 0.18 }, rightWrist: { x: 0.64, y: 0.05 } })), null);
  // bent arm held at shoulder height (carrying something close)
  assert.equal(aimingArm(body(0, { rightElbow: { x: 0.66, y: 0.36 }, rightWrist: { x: 0.6, y: 0.3 } })), null);
});

test("the pose must be held before it counts, then cools down", () => {
  const watch = new ThreatWatch();
  const kinds = new Set(["firearm"]);
  assert.equal(watch.update(body(0, rightArmOut), kinds), null);
  assert.equal(watch.update(body(AIM_HOLD_MS - 100, rightArmOut), kinds), null);
  assert.match(watch.update(body(AIM_HOLD_MS + 10, rightArmOut), kinds) ?? "", /possible aiming/);
  assert.equal(watch.update(body(AIM_HOLD_MS + 500, rightArmOut), kinds), null); // cooling down
  assert.match(watch.update(body(AIM_HOLD_MS + THREAT_COOLDOWN_MS + 20, rightArmOut), kinds) ?? "", /aiming/);
});

test("no threat rule, no signal; a lowered arm resets the hold", () => {
  const watch = new ThreatWatch();
  assert.equal(watch.update(body(0, rightArmOut), new Set()), null);
  assert.equal(watch.update(body(AIM_HOLD_MS * 2, rightArmOut), new Set()), null);
  const kinds = new Set(["firearm"]);
  watch.update(body(0, rightArmOut), kinds);
  watch.update(body(400), kinds); // arm down
  assert.equal(watch.update(body(AIM_HOLD_MS + 50, rightArmOut), kinds), null);
});

test("a knife next to a hand counts for knife rules, not firearm-only rules", () => {
  const knife = [{ label: "knife", x: 0.53, y: 0.5, w: 0.06, h: 0.08 }];
  assert.equal(weaponInHand(body(0), knife)?.label, "knife");
  assert.equal(weaponInHand(body(0), [{ label: "bottle", x: 0.53, y: 0.5, w: 0.06, h: 0.08 }]), null);
  assert.equal(new ThreatWatch().update(body(0), new Set(["firearm"]), knife), null);
  assert.match(new ThreatWatch().update(body(0), new Set(["knife"]), knife) ?? "", /knife is next to a hand/);
});

test("with a threat rule active the engine sends at once, with a threat trigger", () => {
  const zones = polygonsFor([{ id: "z-spirits", name: "Spirits", kind: "shelf" }]);
  const rule: Rule = {
    id: "rule-threat",
    source_text: "Alert if anyone points a gun",
    enabled: true,
    created_at: "2026-10-19T00:00:00Z",
    source: "live",
    spec: {
      supported: true, unsupported_reason: null, type: "THREAT", zone_id: null, min_seconds: null,
      active_from: null, active_to: null, sensitivity: null, threat_of: "firearm", severity: "HIGH",
      summary: "Alert if anyone points a gun",
    },
  };
  const watched = new Tier1Engine("floor", zones, [rule]);
  const unwatched = new Tier1Engine("floor", zones, []);
  let sent: { reason: string; trigger?: string } | null = null;
  let quietSent = false;
  for (let t = 0; t <= 1200; t += 100) {
    const tick = watched.tick(body(t, rightArmOut));
    if (tick.shouldSend && !sent) sent = { reason: tick.reason, trigger: tick.hits.find((h) => h.kind === "THREAT")?.trigger };
    quietSent ||= unwatched.tick(body(t, rightArmOut)).shouldSend;
  }
  assert.ok(sent);
  assert.match(sent.reason, /Possible threat/);
  assert.equal(sent.trigger, "threat");
  assert.equal(quietSent, false);
});
