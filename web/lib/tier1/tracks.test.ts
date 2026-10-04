import assert from "node:assert/strict";
import test from "node:test";
import { Tier1Engine } from "./engine.ts";
import { polygonsFor } from "./geometry.ts";
import { PersonTracker, type SeenPerson } from "./tracks.ts";
import type { Rule } from "../types.ts";

const zones = polygonsFor([
  { id: "z-scan-1", name: "Scanner", kind: "scanner" },
  { id: "z-bag-1", name: "Bagging", kind: "bagging" },
]);

test("two people stay on separate tracks and the hotter score wins", () => {
  const tracker = new PersonTracker(() => new Tier1Engine("checkout", zones, []));
  const calm = {
    hip: { x: 0.2, y: 0.8 },
    box: [100, 50, 400, 300] as [number, number, number, number],
    sample: {
      tMs: 0,
      present: true,
      leftHip: { x: 0.18, y: 0.8 },
      rightHip: { x: 0.22, y: 0.8 },
      leftWrist: { x: 0.2, y: 0.7 },
    },
  };
  let hotter = 0;
  for (let i = 0; i < 16; i++) {
    const approach = i < 6;
    const result = tracker.update(
      [
        { ...calm, sample: { ...calm.sample, tMs: i * 100 } },
        {
          hip: { x: 0.75, y: 0.5 },
          box: [200, 600, 900, 900],
          sample: {
            tMs: i * 100,
            present: true,
            leftWrist: approach ? { x: 0.12 + i * 0.06, y: 0.28 } : { x: 0.75, y: 0.5 },
            leftHip: { x: 0.73, y: 0.5 },
            rightHip: { x: 0.77, y: 0.5 },
          },
        },
      ],
      i * 100,
    );
    hotter = Math.max(hotter, result.tick.smoothed);
    if (i === 10) assert.equal(result.boxes.length, 2);
  }
  assert.ok(hotter > 0.4);
});

test("a person who returns within a second keeps the same track", () => {
  const tracker = new PersonTracker(() => new Tier1Engine("floor", [], []));
  const person = {
    hip: { x: 0.4, y: 0.6 },
    box: [100, 200, 800, 600] as [number, number, number, number],
    sample: {
      tMs: 0,
      present: true,
      leftHip: { x: 0.38, y: 0.6 },
      rightHip: { x: 0.42, y: 0.6 },
    },
  };
  const first = tracker.update([person], 0);
  const back = tracker.update([{ ...person, sample: { ...person.sample, tMs: 400 } }], 400);
  assert.equal(back.activeId, first.activeId);
});

test("a vanished duplicate does not send lane-leave while someone is still in frame", () => {
  const floor = polygonsFor([{ id: "z-exit", name: "Exit", kind: "exit" }]);
  const rule: Rule = {
    id: "r",
    source_text: "test",
    enabled: true,
    created_at: "2026-10-04T00:00:00Z",
    source: "seed",
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
  };
  const tracker = new PersonTracker(() => new Tier1Engine("checkout", floor, [rule], () => new Date("2026-10-04T12:00:00")));
  tracker.setLaneLeave(true);
  const ghost: SeenPerson = {
    hip: { x: 0.8, y: 0.5 },
    box: [200, 700, 900, 950],
    sample: {
      tMs: 0,
      present: true,
      leftHip: { x: 0.78, y: 0.5 },
      rightHip: { x: 0.82, y: 0.5 },
      leftWrist: { x: 0.8, y: 0.4 },
    },
  };
  const shopper: SeenPerson = {
    hip: { x: 0.3, y: 0.7 },
    box: [100, 200, 800, 500],
    sample: {
      tMs: 0,
      present: true,
      leftHip: { x: 0.28, y: 0.7 },
      rightHip: { x: 0.32, y: 0.7 },
      leftWrist: { x: 0.3, y: 0.6 },
    },
  };
  for (let i = 0; i < 25; i++) {
    tracker.update(
      [
        { ...ghost, sample: { ...ghost.sample, tMs: i * 100 } },
        { ...shopper, sample: { ...shopper.sample, tMs: i * 100 } },
      ],
      i * 100,
    );
  }
  let sent = false;
  for (let i = 25; i < 50; i++) {
    const tick = tracker.update([{ ...shopper, sample: { ...shopper.sample, tMs: i * 100 } }], i * 100).tick;
    sent ||= tick.shouldSend;
  }
  assert.equal(sent, false);
});
