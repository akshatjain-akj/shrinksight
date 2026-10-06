import assert from "node:assert/strict";
import test from "node:test";
import type { BodySample } from "./engine.ts";
import { polygonsFor, type Pt } from "./geometry.ts";
import { ClipMeasure } from "./measure.ts";
import { SAMPLE_MS } from "./screen.ts";

const floorZones = polygonsFor([{ id: "z-spirits", name: "Spirits", kind: "shelf" }]);
const checkoutZones = polygonsFor([
  { id: "z-pick-1", name: "Item pile", kind: "pickup" },
  { id: "z-scan-1", name: "Scanner", kind: "scanner" },
  { id: "z-bag-1", name: "Bagging", kind: "bagging" },
]);

const body = { leftShoulder: { x: 0.32, y: 0.22 }, leftHip: { x: 0.34, y: 0.62 }, rightHip: { x: 0.42, y: 0.62 } };
const sample = (tMs: number, extra: Partial<BodySample>): BodySample => ({ tMs, present: true, ...body, ...extra });

test("a reach then a hand held at the pocket is one shelf contact and one hold, in clip seconds", () => {
  const m = new ClipMeasure("floor", floorZones);
  for (let i = 0; i < 30; i++) {
    m.feed(i * SAMPLE_MS, sample(i * SAMPLE_MS, { leftWrist: i < 6 ? { x: 0.62, y: 0.4 } : { x: 0.38, y: 0.5 } }));
  }
  const out = m.result();
  assert.equal(out.person_seen, 1);
  assert.deepEqual(out.shelf_contacts, [{ hand: "left", start_s: 0, end_s: 0.6 }]);
  assert.equal(out.holds.length, 1);
  const [hold] = out.holds;
  assert.equal(hold.hand, "left");
  assert.equal(hold.spot, "pocket");
  assert.equal(hold.after_shelf_s, 0.6);
  assert.ok(hold.end_s - hold.start_s >= 2);
  assert.equal(out.trips, null);
  assert.deepEqual(
    ClipMeasure.closeUps(out).map((c) => [c.label, c.moment]),
    [["hand_1", "shelf_exit"], ["hand_2", "hold"]],
  );
});

test("standing with hands down measures nothing", () => {
  const m = new ClipMeasure("floor", floorZones);
  for (let i = 0; i < 30; i++) {
    m.feed(i * SAMPLE_MS, {
      tMs: i * SAMPLE_MS,
      present: true,
      leftShoulder: { x: 0.7, y: 0.3 },
      leftHip: { x: 0.7, y: 0.62 },
      rightHip: { x: 0.76, y: 0.62 },
      leftWrist: { x: 0.68, y: 0.68 },
    });
  }
  const out = m.result();
  assert.deepEqual(out.shelf_contacts, []);
  assert.deepEqual(out.holds, []);
});

test("a hand resting at the pocket with no shelf visit first is not a hold", () => {
  const m = new ClipMeasure("floor", floorZones);
  for (let i = 0; i < 30; i++) m.feed(i * SAMPLE_MS, sample(i * SAMPLE_MS, { leftWrist: { x: 0.38, y: 0.5 } }));
  assert.deepEqual(m.result().holds, []);
});

const PILE: Pt = { x: 0.18, y: 0.55 };
const SCAN: Pt = { x: 0.47, y: 0.5 };
const BAG: Pt = { x: 0.78, y: 0.5 };
const MID: Pt = { x: 0.62, y: 0.2 }; // between zones, above the scanner

/** Feeds one wrist path per hand: each entry is held for `hold` samples. */
function run(paths: { left?: Pt[]; right?: Pt[] }, hold = 3) {
  const m = new ClipMeasure("checkout", checkoutZones);
  const steps = Math.max(paths.left?.length ?? 0, paths.right?.length ?? 0);
  let t = 0;
  for (let step = 0; step < steps; step++) {
    for (let k = 0; k < hold; k++, t += SAMPLE_MS) {
      m.feed(t, { tMs: t, present: true, leftWrist: paths.left?.[step] ?? null, rightWrist: paths.right?.[step] ?? null });
    }
  }
  return m.result();
}

test("checkout: three items through the scanner are three scanned trips", () => {
  const out = run({ left: [PILE, SCAN, BAG, PILE, SCAN, BAG, PILE, SCAN, BAG] });
  assert.equal(out.trips?.length, 3);
  assert.ok(out.trips!.every((trip) => trip.via_scanner));
  assert.ok(out.trips!.every((trip) => trip.end_s > trip.start_s));
});

test("checkout: an item carried around the scanner is a trip without the scanner", () => {
  const out = run({ left: [PILE, SCAN, BAG, PILE, MID, BAG] });
  assert.deepEqual(out.trips?.map((trip) => trip.via_scanner), [true, false]);
});

test("checkout: one hand picking while the other bags still counts both trips", () => {
  const out = run({
    left: [PILE, SCAN, BAG, MID, MID, MID],
    right: [MID, MID, PILE, SCAN, BAG, MID],
  });
  assert.equal(out.trips?.length, 2);
  assert.ok(out.trips!.every((trip) => trip.via_scanner));
});

test("checkout: an item passed from one hand to the other is one trip", () => {
  const out = run({ left: [PILE, SCAN, null as unknown as Pt, MID], right: [MID, MID, BAG, MID] });
  assert.equal(out.trips?.length, 1);
  assert.equal(out.trips![0].via_scanner, true);
});

test("checkout: a hand in the bag without an item from the pile is not a trip", () => {
  const out = run({ left: [MID, BAG, MID, BAG] });
  assert.deepEqual(out.trips, []);
});

test("checkout trips are unknown when the item pile isn't marked", () => {
  const m = new ClipMeasure("checkout", checkoutZones.filter((zone) => zone.kind !== "pickup"));
  assert.equal(m.ready, false);
  m.feed(0, { tMs: 0, present: true, leftWrist: BAG });
  assert.equal(m.result().trips, null);
});

test("checkout close-ups are one per trip at the bagging area", () => {
  const out = run({ left: [PILE, SCAN, BAG, PILE, MID, BAG] });
  assert.deepEqual(
    ClipMeasure.closeUps(out).map((c) => [c.label, c.moment, c.t_s]),
    out.trips!.map((trip, i) => [`trip_${i + 1}`, "bagging", trip.end_s]),
  );
});
