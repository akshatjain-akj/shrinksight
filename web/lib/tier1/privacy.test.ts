import assert from "node:assert/strict";
import test from "node:test";
import { headBoxFromPose, privacyBoxes, type PoseLandmark } from "./privacy.ts";

function pose(overrides: Record<number, PoseLandmark> = {}): PoseLandmark[] {
  const base: PoseLandmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
  // A small, distant person: head around (0.5, 0.2), shoulders 0.06 apart.
  base[0] = { x: 0.5, y: 0.2, visibility: 0.9 };
  base[2] = { x: 0.49, y: 0.19, visibility: 0.9 };
  base[5] = { x: 0.51, y: 0.19, visibility: 0.9 };
  base[7] = { x: 0.485, y: 0.2, visibility: 0.8 };
  base[8] = { x: 0.515, y: 0.2, visibility: 0.8 };
  base[11] = { x: 0.47, y: 0.26, visibility: 0.9 };
  base[12] = { x: 0.53, y: 0.26, visibility: 0.9 };
  return base.map((p, i) => overrides[i] ?? p);
}

const contains = (b: { originX: number; originY: number; width: number; height: number }, x: number, y: number) =>
  x >= b.originX && x <= b.originX + b.width && y >= b.originY && y <= b.originY + b.height;

test("a distant head gets a box covering the nose, eyes and ears", () => {
  const box = headBoxFromPose(pose(), 1280, 720);
  assert.ok(box);
  for (const i of [0, 2, 5, 7, 8]) {
    const p = pose()[i];
    assert.ok(contains(box, p.x * 1280, p.y * 720), `landmark ${i} inside`);
  }
  assert.ok(box.width >= 1280 * 0.06 * 0.55 * 1.7 - 1, "scaled from the shoulder span");
});

test("no box when the head isn't visible", () => {
  const hidden = pose(Object.fromEntries([0, 2, 5, 7, 8].map((i) => [i, { x: 0.5, y: 0.2, visibility: 0.05 }])));
  assert.equal(headBoxFromPose(hidden, 1280, 720), null);
});

test("privacy boxes combine face detections with pose heads", () => {
  const face = { originX: 10, originY: 10, width: 40, height: 40 };
  assert.equal(privacyBoxes([face], [pose(), pose()], 1280, 720).length, 3);
  assert.equal(privacyBoxes([], [], 1280, 720).length, 0);
});
