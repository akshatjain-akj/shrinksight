import assert from "node:assert/strict";
import test from "node:test";
import { AlertOnce, forDemoMode } from "./demoAlerts.ts";

test("demo-clip incidents are hidden unless demo mode is on", () => {
  const items = [{ id: "a", source: "live" }, { id: "b", source: "demo" }, { id: "c", source: "seed" }];
  assert.deepEqual(forDemoMode(items, false).map((i) => i.id), ["a", "c"]);
  assert.deepEqual(forDemoMode(items, true).map((i) => i.id), ["a", "b", "c"]);
});

test("a looping clip alerts once, when it first reaches the analysed moment", () => {
  const alerts = new AlertOnce();
  assert.equal(alerts.check("demo/floor/a.mp4", 4.2, 1.0), false);
  assert.equal(alerts.check("demo/floor/a.mp4", 4.2, 4.3), true);
  assert.equal(alerts.check("demo/floor/a.mp4", 4.2, 4.5), false);
  // the next loop stays quiet
  assert.equal(alerts.check("demo/floor/a.mp4", 4.2, 0.5), false);
  assert.equal(alerts.check("demo/floor/a.mp4", 4.2, 4.3), false);
  assert.equal(alerts.check("demo/floor/b.mp4", 0, 0), true);
  assert.equal(alerts.has("demo/floor/a.mp4"), true);
});
