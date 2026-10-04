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
