import assert from "node:assert/strict";
import test from "node:test";
import { Tier1Engine, type EdgeTuning } from "./engine.ts";
import { polygonsFor } from "./geometry.ts";
import { ClipScreen, SAMPLE_MS } from "./screen.ts";
import { PersonTracker, type SeenPerson } from "./tracks.ts";

const floorZones = polygonsFor([
  { id: "z-spirits", name: "Spirits", kind: "shelf" },
  { id: "z-exit", name: "Exit", kind: "exit" },
]);

function screen(tuning?: EdgeTuning) {
  const tracker = new PersonTracker(() => new Tier1Engine("floor", floorZones, [], () => new Date("2026-10-04T12:00:00")));
  if (tuning) tracker.setTuning(tuning);
  return new ClipScreen(tracker);
}

/** A shopper reaching into the shelf, then holding the hand at the pocket (the engine tests' pocket hide). */
function pocketHide(i: number): SeenPerson[] {
  const reaching = i < 6;
  const sample = {
    tMs: 0,
    present: true,
    leftShoulder: { x: 0.3, y: 0.25 },
    leftWrist: reaching ? { x: 0.3, y: 0.3 } : { x: 0.32, y: 0.78 },
    leftHip: { x: 0.3, y: 0.8 },
    rightHip: { x: 0.34, y: 0.8 },
  };
  return [{ hip: { x: 0.32, y: 0.8 }, box: null, sample }];
}

/** Someone standing still in the middle of the aisle with hands down. */
function standing(): SeenPerson[] {
  const sample = {
    tMs: 0,
    present: true,
    leftShoulder: { x: 0.7, y: 0.3 },
    leftWrist: { x: 0.7, y: 0.6 },
    leftHip: { x: 0.7, y: 0.62 },
    rightHip: { x: 0.76, y: 0.62 },
  };
  return [{ hip: { x: 0.73, y: 0.62 }, box: null, sample }];
}

test("a pocket hide in an uploaded clip opens the gate, with clip-relative hints", () => {
  const s = screen();
  for (let i = 0; i < 40; i++) s.feed(i * SAMPLE_MS, pocketHide(i));
  const result = s.result();
  assert.equal(result.flagged, true);
  assert.ok(result.openedAtMs != null && result.openedAtMs < 4000);
  assert.ok(result.hits.some((hit) => hit.kind === "CONCEALMENT"));
  assert.ok(result.hits.every((hit) => /^\d\d:\d\d\.\d$/.test(hit.t) && !("atMs" in hit)));
  assert.equal(result.personSeen, 1);
  assert.notEqual(result.reachAtMs, null);
});

test("a person just standing there is cleared without a Gemini call", () => {
  const s = screen();
  for (let i = 0; i < 40; i++) s.feed(i * SAMPLE_MS, standing());
  const result = s.result();
  assert.equal(result.flagged, false);
  assert.equal(result.openedAtMs, null);
  assert.ok(result.peakScore < 0.4);
});

test("an empty clip is cleared and says nobody was seen", () => {
  const s = screen();
  for (let i = 0; i < 20; i++) s.feed(i * SAMPLE_MS, []);
  const result = s.result();
  assert.equal(result.flagged, false);
  assert.equal(result.personSeen, 0);
  assert.deepEqual(result.hits, []);
});

test("the camera's auto-tuned gate is applied to the scan", () => {
  const strict = screen({ sendScore: 0.99, hotFrames: 500, holdExtraMs: 900 });
  for (let i = 0; i < 40; i++) strict.feed(i * SAMPLE_MS, pocketHide(i));
  assert.equal(strict.result().flagged, false);
});
