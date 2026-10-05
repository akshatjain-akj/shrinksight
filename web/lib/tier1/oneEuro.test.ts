import assert from "node:assert/strict";
import test from "node:test";
import { OneEuroFilter, PoseSmoother } from "./oneEuro.ts";

test("jitter on a still point is smoothed", () => {
  const f = new OneEuroFilter();
  const out: number[] = [];
  for (let i = 0; i < 60; i++) out.push(f.filter(0.5 + (i % 2 ? 0.01 : -0.01), i * 33));
  const tail = out.slice(-20);
  const spread = Math.max(...tail) - Math.min(...tail);
  assert.ok(spread < 0.01, `smoothed spread ${spread} should be below the raw 0.02`);
});

test("a fast movement is followed without large lag", () => {
  const f = new OneEuroFilter();
  for (let i = 0; i < 10; i++) f.filter(0.2, i * 33);
  let last = 0;
  for (let i = 10; i < 25; i++) last = f.filter(0.8, i * 33);
  assert.ok(last > 0.7, `after ~0.5 s at the new position the filter reached ${last.toFixed(2)}`);
});

test("people keep their own smoothing even when poses arrive in a different order", () => {
  const smoother = new PoseSmoother();
  const person = (x: number) => Array.from({ length: 33 }, () => ({ x, y: 0.5, visibility: 1 }));
  smoother.smooth([person(0.2), person(0.8)], 0);
  const [a, b] = smoother.smooth([person(0.81), person(0.21)], 33);
  assert.ok(Math.abs(a[0].x - 0.81) < 0.05 && Math.abs(b[0].x - 0.21) < 0.05);
});
