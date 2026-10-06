import assert from "node:assert/strict";
import test from "node:test";
import { pickFour, type TimedStill } from "./stills.ts";

function shots(): TimedStill[] {
  return [0, 400, 800, 1500, 2200, 3000].map((tMs) => ({ tMs, blob: new Blob([String(tMs)]) }));
}

test("picks the frame before the reach, the reach, the hold, and the last frame", async () => {
  const picked = pickFour(shots(), 1500, 2200);
  assert.deepEqual(picked.map((still) => still.label), ["before", "reach", "hold", "after"]);
  const texts = await Promise.all(picked.map((still) => still.blob.text()));
  assert.deepEqual(texts, ["800", "1500", "2200", "3000"]);
});

test("spreads four frames when the reach time is unknown", () => {
  const picked = pickFour(shots(), null, null);
  assert.equal(picked.length, 4);
  assert.equal(new Set(picked.map((still) => still.label)).size, 4);
});

test("returns nothing when the buffer is empty", () => {
  assert.deepEqual(pickFour([], 1000, 2000), []);
});

test("hand crop is a padded square around the wrists, kept inside the canvas", async () => {
  const { handRect } = await import("./stills.ts");
  const box = handRect([{ x: 300, y: 200 }, { x: 340, y: 230 }], 640, 360)!;
  assert.equal(box.w, box.h);
  assert.ok(box.w >= 96 && box.x <= 300 && box.x + box.w >= 340 && box.y <= 200 && box.y + box.h >= 230);
  const corner = handRect([{ x: 635, y: 355 }], 640, 360)!;
  assert.ok(corner.x + corner.w <= 640 && corner.y + corner.h <= 360 && corner.x >= 0 && corner.y >= 0);
  assert.equal(handRect([], 640, 360), null);
});

test("hand close-ups are the shots nearest the reach and the hide, only when close enough", async () => {
  const { pickHands } = await import("./stills.ts");
  const picked = pickHands(shots(), 1450, 2300);
  assert.deepEqual(picked.map((p) => p.label), ["hand_reach", "hand_hold"]);
  assert.equal(pickHands(shots(), 9000, null).length, 0, "no shot within 600 ms of the reach");
  assert.equal(pickHands(shots(), null, null).length, 0);
});

test("hint times are moved to clip time", async () => {
  const { toClipTime } = await import("./stills.ts");
  const hits = toClipTime([{ t: "02:31.4", kind: "CONCEALMENT", atMs: 151_400 }, { t: "00:01.0", kind: "X" }], 146_200);
  assert.deepEqual(hits, [{ t: "00:05.2", kind: "CONCEALMENT" }, { t: "00:01.0", kind: "X" }]);
});
