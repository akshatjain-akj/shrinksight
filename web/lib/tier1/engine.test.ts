import assert from "node:assert/strict";
import test from "node:test";
import { Tier1Engine } from "./engine.ts";
import { polygonsFor } from "./geometry.ts";
import type { Rule } from "../types.ts";

const checkoutZones = polygonsFor([
  { id: "z-scan-1", name: "Scanner", kind: "scanner" },
  { id: "z-bag-1", name: "Bagging", kind: "bagging" },
]);

const floorZones = polygonsFor([
  { id: "z-spirits", name: "Spirits", kind: "shelf" },
  { id: "z-exit", name: "Exit", kind: "exit" },
]);

function rule(partial: Partial<Rule> & Pick<Rule, "spec">): Rule {
  return {
    id: "r",
    source_text: "test",
    enabled: true,
    created_at: "2026-10-04T00:00:00Z",
    source: "seed",
    ...partial,
  };
}

test("scanner bypass fires when the hand skips the scanner", () => {
  const engine = new Tier1Engine("checkout", checkoutZones, []);
  let sent = false;
  for (let i = 0; i < 16; i++) {
    const approach = i < 6;
    const tick = engine.tick({
      tMs: i * 100,
      present: true,
      leftWrist: approach ? { x: 0.12 + i * 0.06, y: 0.28 } : { x: 0.75, y: 0.5 },
      leftHip: { x: 0.5, y: 0.8 },
      rightHip: { x: 0.55, y: 0.8 },
    });
    sent ||= tick.shouldSend && tick.hits.some((h) => h.kind === "SCANNER_BYPASS");
  }
  assert.equal(sent, true);
});

test("a hand that crosses the scanner is not a bypass", () => {
  const engine = new Tier1Engine("checkout", checkoutZones, []);
  let sent = false;
  for (let i = 0; i < 12; i++) {
    const tick = engine.tick({
      tMs: i * 100,
      present: true,
      leftWrist: { x: 0.42, y: 0.48 },
      leftHip: { x: 0.5, y: 0.75 },
      rightHip: { x: 0.55, y: 0.75 },
    });
    sent ||= tick.shouldSend && tick.hits.some((h) => h.kind === "SCANNER_BYPASS");
  }
  assert.equal(sent, false);
});

test("dwell uses the rule window and the zone", () => {
  const engine = new Tier1Engine(
    "floor",
    floorZones,
    [
      rule({
        spec: {
          supported: true,
          unsupported_reason: null,
          type: "DWELL",
          zone_id: "z-spirits",
          min_seconds: 1,
          active_from: null,
          active_to: null,
          sensitivity: null,
          severity: "MEDIUM",
          summary: "Loitering at spirits",
        },
      }),
    ],
    () => new Date("2026-10-04T12:00:00"),
  );
  let dwell = false;
  for (let i = 0; i < 20; i++) {
    const tick = engine.tick({
      tMs: i * 100,
      present: true,
      leftHip: { x: 0.3, y: 0.4 },
      rightHip: { x: 0.34, y: 0.4 },
      leftWrist: { x: 0.3, y: 0.3 },
    });
    dwell ||= tick.hits.some((h) => h.kind === "DWELL");
  }
  assert.equal(dwell, true);
});

test("an empty lane leave does not upload", () => {
  const engine = new Tier1Engine("checkout", checkoutZones, []);
  engine.alwaysCheckTill = true;
  for (let i = 0; i < 30; i++) {
    engine.tick({
      tMs: i * 100,
      present: true,
      leftHip: { x: 0.5, y: 0.8 },
      rightHip: { x: 0.55, y: 0.8 },
      leftWrist: { x: 0.5, y: 0.7 },
    });
  }
  let sent = false;
  for (let i = 30; i < 55; i++) {
    sent ||= engine.tick({ tMs: i * 100, present: false }).shouldSend;
  }
  assert.equal(sent, false);
});

test("lane leave after a real signal sends when the till check is on", () => {
  const engine = new Tier1Engine(
    "checkout",
    polygonsFor([
      { id: "z-scan-1", name: "Scanner", kind: "scanner" },
      { id: "z-bag-1", name: "Bagging", kind: "bagging" },
      { id: "z-exit", name: "Exit", kind: "exit" },
    ]),
    [
      rule({
        spec: {
          supported: true,
          unsupported_reason: null,
          type: "ZONE_ENTRY",
          zone_id: "z-exit",
          min_seconds: null,
          active_from: null,
          active_to: null,
          sensitivity: null,
          severity: "MEDIUM",
          summary: "Entered the exit",
        },
      }),
    ],
    () => new Date("2026-10-04T12:00:00"),
  );
  engine.alwaysCheckTill = true;
  engine.tick({
    tMs: 0,
    present: true,
    leftHip: { x: 0.8, y: 0.5 },
    rightHip: { x: 0.84, y: 0.5 },
    leftWrist: { x: 0.8, y: 0.4 },
    box: [200, 300, 800, 700],
  });
  for (let i = 1; i < 25; i++) {
    engine.tick({
      tMs: i * 100,
      present: true,
      leftHip: { x: 0.5, y: 0.8 },
      rightHip: { x: 0.55, y: 0.8 },
      leftWrist: { x: 0.5, y: 0.7 },
    });
  }
  let sent = false;
  let trigger = "";
  for (let i = 25; i < 50; i++) {
    const tick = engine.tick({ tMs: i * 100, present: false });
    if (tick.shouldSend) {
      sent = true;
      trigger = tick.hits.find((h) => h.kind === "LANE_CLEAR")?.trigger ?? "";
    }
  }
  assert.equal(sent, true);
  assert.equal(trigger, "lane_leave");
});

test("a shelf reach opens the gate when the hand never hides", () => {
  const engine = new Tier1Engine("floor", floorZones, [], () => new Date("2026-10-04T12:00:00"));
  let sent = false;
  let concealed = false;
  for (let i = 0; i < 20; i++) {
    const tick = engine.tick({
      tMs: i * 100,
      present: true,
      leftShoulder: { x: 0.32, y: 0.4 },
      leftHip: { x: 0.34, y: 0.62 },
      rightHip: { x: 0.42, y: 0.62 },
      leftWrist: i < 4 ? { x: 0.55, y: 0.3 } : { x: 0.6, y: 0.62 },
    });
    sent ||= tick.shouldSend;
    concealed ||= tick.hits.some((hit) => hit.kind === "CONCEALMENT");
  }
  assert.equal(sent, true);
  assert.equal(concealed, false);
});

test("hands at the hip inside the shelf are not concealment", () => {
  const engine = new Tier1Engine("floor", floorZones, [], () => new Date("2026-10-04T12:00:00"));
  let fired = false;
  for (let i = 0; i < 30; i++) {
    const tick = engine.tick({
      tMs: i * 100,
      present: true,
      leftShoulder: { x: 0.32, y: 0.28 },
      rightShoulder: { x: 0.42, y: 0.28 },
      leftWrist: { x: 0.34, y: 0.55 },
      rightWrist: { x: 0.4, y: 0.55 },
      leftHip: { x: 0.34, y: 0.58 },
      rightHip: { x: 0.4, y: 0.58 },
    });
    fired ||= tick.hits.some((h) => h.kind === "CONCEALMENT") || tick.shouldSend;
  }
  assert.equal(fired, false);
});

test("one pocket frame does not fire concealment", () => {
  const engine = new Tier1Engine("floor", floorZones, [], () => new Date("2026-10-04T12:00:00"));
  let fired = false;
  for (let i = 0; i < 8; i++) {
    const tick = engine.tick({
      tMs: i * 100,
      present: true,
      leftShoulder: { x: 0.3, y: 0.25 },
      leftWrist: i < 4 ? { x: 0.3, y: 0.3 } : { x: 0.3, y: 0.4 },
      leftHip: { x: 0.3, y: 0.8 },
      rightHip: { x: 0.34, y: 0.8 },
    });
    fired ||= tick.hits.some((h) => h.kind === "CONCEALMENT");
  }
  assert.equal(fired, false);
});

test("a hand that returns from the side into the jacket pocket is concealment", () => {
  const engine = new Tier1Engine("floor", floorZones, [], () => new Date("2026-10-04T12:00:00"));
  let fired = false;
  for (let i = 0; i < 30; i++) {
    const out = i < 6;
    const tick = engine.tick({
      tMs: i * 100,
      present: true,
      leftShoulder: { x: 0.32, y: 0.22 },
      leftHip: { x: 0.34, y: 0.62 },
      rightHip: { x: 0.42, y: 0.62 },
      leftWrist: out ? { x: 0.62, y: 0.4 } : { x: 0.38, y: 0.5 },
    });
    fired ||= tick.hits.some((h) => h.kind === "CONCEALMENT");
  }
  assert.equal(fired, true);
});

test("a hand that drops below the hip after a reach is a waistband hide", () => {
  const engine = new Tier1Engine("floor", floorZones, [], () => new Date("2026-10-04T12:00:00"));
  let detail = "";
  for (let i = 0; i < 30; i++) {
    const tick = engine.tick({
      tMs: i * 100,
      present: true,
      leftShoulder: { x: 0.32, y: 0.22 },
      leftHip: { x: 0.34, y: 0.62 },
      rightHip: { x: 0.42, y: 0.62 },
      leftWrist: i < 6 ? { x: 0.5, y: 0.3 } : { x: 0.34, y: 0.72 },
    });
    detail = tick.hits.find((hit) => hit.kind === "CONCEALMENT")?.detail ?? detail;
  }
  assert.match(detail, /waistband/);
});

test("a hand held at the centre of the torso after a reach is under the shirt", () => {
  const engine = new Tier1Engine("floor", floorZones, [], () => new Date("2026-10-04T12:00:00"));
  let detail = "";
  for (let i = 0; i < 30; i++) {
    const tick = engine.tick({
      tMs: i * 100,
      present: true,
      leftShoulder: { x: 0.3, y: 0.22 },
      rightShoulder: { x: 0.46, y: 0.22 },
      leftHip: { x: 0.32, y: 0.72 },
      rightHip: { x: 0.44, y: 0.72 },
      leftWrist: i < 6 ? { x: 0.55, y: 0.3 } : { x: 0.38, y: 0.4 },
    });
    detail = tick.hits.find((hit) => hit.kind === "CONCEALMENT")?.detail ?? detail;
  }
  assert.match(detail, /shirt/);
});

test("a hand held out at the hip after a reach is a bag hide", () => {
  const engine = new Tier1Engine("floor", floorZones, [], () => new Date("2026-10-04T12:00:00"));
  let detail = "";
  for (let i = 0; i < 30; i++) {
    const tick = engine.tick({
      tMs: i * 100,
      present: true,
      leftShoulder: { x: 0.32, y: 0.22 },
      leftHip: { x: 0.34, y: 0.62 },
      rightHip: { x: 0.42, y: 0.62 },
      leftWrist: i < 6 ? { x: 0.5, y: 0.3 } : { x: 0.7, y: 0.62 },
    });
    detail = tick.hits.find((hit) => hit.kind === "CONCEALMENT")?.detail ?? detail;
  }
  assert.match(detail, /bag/);
});

test("a reach outside the shelf does not become a hide", () => {
  const engine = new Tier1Engine("floor", floorZones, [], () => new Date("2026-10-04T12:00:00"));
  let fired = false;
  for (let i = 0; i < 30; i++) {
    const tick = engine.tick({
      tMs: i * 100,
      present: true,
      leftShoulder: { x: 0.32, y: 0.22 },
      leftHip: { x: 0.34, y: 0.62 },
      rightHip: { x: 0.42, y: 0.62 },
      leftWrist: i < 6 ? { x: 0.9, y: 0.4 } : { x: 0.36, y: 0.58 },
    });
    fired ||= tick.hits.some((hit) => hit.kind === "CONCEALMENT");
  }
  assert.equal(fired, false);
});

test("a hand that returns to a basket after a shelf reach is not a hide", () => {
  const engine = new Tier1Engine("floor", floorZones, [], () => new Date("2026-10-04T12:00:00"));
  let fired = false;
  for (let i = 0; i < 30; i++) {
    const tick = engine.tick({
      tMs: i * 100,
      present: true,
      leftShoulder: { x: 0.32, y: 0.22 },
      leftHip: { x: 0.34, y: 0.62 },
      rightHip: { x: 0.42, y: 0.62 },
      leftWrist: i < 6 ? { x: 0.55, y: 0.3 } : { x: 0.6, y: 0.62 },
    });
    fired ||= tick.hits.some((hit) => hit.kind === "CONCEALMENT");
  }
  assert.equal(fired, false);
});

test("a hand that puts the item back on the shelf is not a hide", () => {
  const engine = new Tier1Engine("floor", floorZones, [], () => new Date("2026-10-04T12:00:00"));
  let hid = false;
  let putBack = false;
  for (let i = 0; i < 28; i++) {
    const tick = engine.tick({
      tMs: i * 100,
      present: true,
      leftShoulder: { x: 0.32, y: 0.22 },
      leftHip: { x: 0.34, y: 0.62 },
      rightHip: { x: 0.42, y: 0.62 },
      leftWrist: i < 6 || i >= 18 ? { x: 0.5, y: 0.18 } : { x: 0.6, y: 0.62 },
    });
    hid ||= tick.hits.some((hit) => hit.kind === "CONCEALMENT");
    putBack ||= tick.hits.some((hit) => hit.detail === "Item put back on the shelf.");
  }
  assert.equal(hid, false);
  assert.equal(putBack, true);
});

test("a hanging arm is not a waistband hide when the other hand puts the item back", () => {
  const engine = new Tier1Engine("floor", floorZones, [], () => new Date("2026-10-04T12:00:00"));
  let hid = false;
  let putBack = false;
  for (let i = 0; i < 28; i++) {
    const tick = engine.tick({
      tMs: i * 100,
      present: true,
      leftShoulder: { x: 0.32, y: 0.22 },
      rightShoulder: { x: 0.46, y: 0.22 },
      leftHip: { x: 0.34, y: 0.62 },
      rightHip: { x: 0.42, y: 0.62 },
      leftWrist: i < 6 || i >= 18 ? { x: 0.5, y: 0.18 } : { x: 0.6, y: 0.62 },
      rightWrist: { x: 0.42, y: 0.74 },
    });
    hid ||= tick.hits.some((hit) => hit.kind === "CONCEALMENT");
    putBack ||= tick.hits.some((hit) => hit.detail === "Item put back on the shelf.");
  }
  assert.equal(hid, false);
  assert.equal(putBack, true);
});

test("a person lying flat on the floor is a health hazard", () => {
  const engine = new Tier1Engine("floor", floorZones, [], () => new Date("2026-10-04T12:00:00"));
  let detail = "";
  for (let i = 0; i < 16; i++) {
    const tick = engine.tick({
      tMs: i * 100,
      present: true,
      leftShoulder: { x: 0.28, y: 0.7 },
      rightShoulder: { x: 0.36, y: 0.72 },
      leftHip: { x: 0.62, y: 0.74 },
      rightHip: { x: 0.7, y: 0.76 },
    });
    detail = tick.hits.find((hit) => hit.kind === "HEALTH_HAZARD")?.detail ?? detail;
  }
  assert.match(detail, /floor/);
});

test("bending toward a shelf is not a health hazard", () => {
  const engine = new Tier1Engine("floor", floorZones, [], () => new Date("2026-10-04T12:00:00"));
  let fired = false;
  for (let i = 0; i < 20; i++) {
    const tick = engine.tick({
      tMs: i * 100,
      present: true,
      leftShoulder: { x: 0.32, y: 0.4 },
      rightShoulder: { x: 0.46, y: 0.4 },
      leftHip: { x: 0.34, y: 0.62 },
      rightHip: { x: 0.44, y: 0.62 },
      leftWrist: { x: 0.5, y: 0.3 },
    });
    fired ||= tick.hits.some((hit) => hit.kind === "HEALTH_HAZARD");
  }
  assert.equal(fired, false);
});

test("health hazard detection stays off when the camera switch is off", () => {
  const engine = new Tier1Engine("floor", floorZones, [], () => new Date("2026-10-04T12:00:00"));
  engine.watchHealth = false;
  let fired = false;
  for (let i = 0; i < 16; i++) {
    const tick = engine.tick({
      tMs: i * 100,
      present: true,
      leftShoulder: { x: 0.28, y: 0.7 },
      leftHip: { x: 0.62, y: 0.74 },
    });
    fired ||= tick.hits.some((hit) => hit.kind === "HEALTH_HAZARD");
  }
  assert.equal(fired, false);
});

test("a held pocket after a reach fires concealment", () => {
  const engine = new Tier1Engine("floor", floorZones, [], () => new Date("2026-10-04T12:00:00"));
  let fired = false;
  for (let i = 0; i < 30; i++) {
    const reaching = i < 6;
    const tick = engine.tick({
      tMs: i * 100,
      present: true,
      leftShoulder: { x: 0.3, y: 0.25 },
      leftWrist: reaching ? { x: 0.3, y: 0.3 } : { x: 0.32, y: 0.78 },
      leftHip: { x: 0.3, y: 0.8 },
      rightHip: { x: 0.34, y: 0.8 },
    });
    fired ||= tick.hits.some((h) => h.kind === "CONCEALMENT");
  }
  assert.equal(fired, true);
});

test("a stricter auto-tuned gate needs more hot frames before sending", () => {
  const bypassRun = (engine: Tier1Engine) => {
    let sent = false;
    for (let i = 0; i < 16; i++) {
      const approach = i < 6;
      const tick = engine.tick({
        tMs: i * 100,
        present: true,
        leftWrist: approach ? { x: 0.12 + i * 0.06, y: 0.28 } : { x: 0.75, y: 0.5 },
        leftHip: { x: 0.5, y: 0.8 },
        rightHip: { x: 0.55, y: 0.8 },
      });
      sent ||= tick.shouldSend;
    }
    return sent;
  };
  assert.equal(bypassRun(new Tier1Engine("checkout", checkoutZones, [])), true);
  const strict = new Tier1Engine("checkout", checkoutZones, []);
  strict.tuning = { sendScore: 0.55, hotFrames: 15, holdExtraMs: 900 };
  assert.equal(bypassRun(strict), false);
});

test("the tracker applies a re-tuned gate to people already in frame and to new ones", async () => {
  const { PersonTracker } = await import("./tracks.ts");
  const tracker = new PersonTracker(() => new Tier1Engine("checkout", checkoutZones, []));
  const person = (x: number) => ({
    hip: { x, y: 0.8 },
    box: null,
    sample: { tMs: 0, present: true, leftHip: { x, y: 0.8 } },
  });
  tracker.update([person(0.3)], 0);
  const strict = { sendScore: 0.5, hotFrames: 12, holdExtraMs: 600 };
  tracker.setTuning(strict);
  tracker.update([person(0.3), person(0.9)], 100);
  const engines = (tracker as unknown as { tracks: { engine: Tier1Engine }[] }).tracks.map((t) => t.engine);
  assert.equal(engines.length, 2);
  assert.ok(engines.every((engine) => engine.tuning === strict));
});

test("a clip that starts at 0 ms has no put-back before any reach", () => {
  const engine = new Tier1Engine("floor", floorZones, [], () => new Date("2026-10-04T12:00:00"));
  const tick = engine.tick({
    tMs: 0,
    present: true,
    leftShoulder: { x: 0.7, y: 0.3 },
    leftHip: { x: 0.7, y: 0.62 },
    rightHip: { x: 0.76, y: 0.62 },
    leftWrist: { x: 0.7, y: 0.6 },
  });
  assert.equal(tick.hits.some((hit) => hit.kind === "PUT_BACK"), false);
  assert.equal(tick.score, 0);
});

/** The jacket-pocket hide above, shrunk to 40% around (0.3, 0.3): the same shopper further from the camera. */
const far = (p: { x: number; y: number }) => ({ x: 0.3 + (p.x - 0.3) * 0.4, y: 0.3 + (p.y - 0.3) * 0.4 });

test("a distant shopper's reach and pocket hide are measured in body lengths, not frame units", () => {
  const engine = new Tier1Engine("floor", floorZones, [], () => new Date("2026-10-04T12:00:00"));
  let reached = false;
  let fired = false;
  for (let i = 0; i < 30; i++) {
    const tick = engine.tick({
      tMs: i * 100,
      present: true,
      leftShoulder: far({ x: 0.32, y: 0.22 }),
      leftHip: far({ x: 0.34, y: 0.62 }),
      rightHip: far({ x: 0.42, y: 0.62 }),
      leftWrist: far(i < 6 ? { x: 0.62, y: 0.4 } : { x: 0.38, y: 0.5 }),
    });
    reached ||= tick.reachAtMs != null;
    fired ||= tick.hits.some((hit) => hit.kind === "CONCEALMENT");
  }
  assert.equal(reached, true);
  assert.equal(fired, true);
});

test("a distant shopper standing with hands down fires nothing", () => {
  const engine = new Tier1Engine("floor", floorZones, [], () => new Date("2026-10-04T12:00:00"));
  let fired = false;
  for (let i = 0; i < 40; i++) {
    const tick = engine.tick({
      tMs: i * 100,
      present: true,
      leftShoulder: far({ x: 0.3, y: 0.22 }),
      rightShoulder: far({ x: 0.46, y: 0.22 }),
      leftHip: far({ x: 0.32, y: 0.62 }),
      rightHip: far({ x: 0.44, y: 0.62 }),
      leftWrist: far({ x: 0.28, y: 0.66 }),
      rightWrist: far({ x: 0.48, y: 0.66 }),
    });
    fired ||= tick.hits.length > 0 || tick.shouldSend;
  }
  assert.equal(fired, false);
});
