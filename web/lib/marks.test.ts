import assert from "node:assert/strict";
import test from "node:test";
import { flaggedItem, markSeconds, visibleMarks } from "./marks.ts";

const box = [100, 100, 300, 300];
const milk = { t: "00:01.0", box_2d: box, scanned: true };
const whisky = { t: "00:04.8", box_2d: box, scanned: false };
const pen = { t: "00:05.2", box_2d: box, scanned: false };
const nobox = { t: "00:04.9", box_2d: [], scanned: false };
const items = [milk, whisky, pen, nobox];

test("reads clip times", () => {
  assert.equal(markSeconds("00:04.8"), 4.8);
  assert.equal(markSeconds("01:02.5"), 62.5);
  assert.equal(markSeconds("bad"), 0);
});

test("opens on the first unpaid item that has a box", () => {
  assert.equal(flaggedItem(items), whisky);
  assert.equal(flaggedItem([milk, nobox]), null);
});

test("boxes appear only around their item's moment, focused item on top", () => {
  assert.deepEqual(visibleMarks(items, whisky, 0), []);
  assert.deepEqual(visibleMarks(items, whisky, 1.3), [milk]);
  assert.deepEqual(visibleMarks(items, whisky, 5.0), [pen, whisky]);
  assert.deepEqual(visibleMarks(items, whisky, 6.5), []);
});

test("without a video only the focused item is drawn", () => {
  assert.deepEqual(visibleMarks(items, whisky, null), [whisky]);
  assert.deepEqual(visibleMarks(items, nobox, null), []);
  assert.deepEqual(visibleMarks(items, null, null), []);
});
