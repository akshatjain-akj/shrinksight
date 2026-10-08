import assert from "node:assert/strict";
import test from "node:test";
import { KEEP_MS, planEviction } from "./localClips.ts";

const MB = 1024 * 1024;
const now = 1_000_000_000;
const limits = { keepMs: KEEP_MS, maxBytes: 100 * MB, maxCount: 3 };

test("clips older than 24 hours are deleted", () => {
  const entries = [
    { incidentId: "old", savedAt: now - KEEP_MS - 1, size: MB },
    { incidentId: "new", savedAt: now - 1000, size: MB },
  ];
  assert.deepEqual(planEviction(entries, now, 0, limits), ["old"]);
});

test("the oldest clips go first when the count limit is reached", () => {
  const entries = ["a", "b", "c"].map((incidentId, i) => ({ incidentId, savedAt: now - 3000 + i * 1000, size: MB }));
  assert.deepEqual(planEviction(entries, now, 0, limits), []);
  assert.deepEqual(planEviction(entries, now, MB, limits), ["a"]);
});

test("room is made for a big incoming clip by size", () => {
  const entries = [
    { incidentId: "a", savedAt: now - 3000, size: 40 * MB },
    { incidentId: "b", savedAt: now - 2000, size: 40 * MB },
  ];
  assert.deepEqual(planEviction(entries, now, 50 * MB, limits), ["a"]);
});

test("nothing to delete when everything is fresh and fits", () => {
  assert.deepEqual(planEviction([{ incidentId: "a", savedAt: now, size: MB }], now, 0, limits), []);
  assert.deepEqual(planEviction([], now, 0, limits), []);
});
