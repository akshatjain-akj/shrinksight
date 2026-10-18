import assert from "node:assert/strict";
import test from "node:test";
import { addSighting, forDemoMode, openForReview, shouldAlert, withDemoIncidents, withSightings, type DemoSighting } from "./demoAlerts.ts";

test("a confirmed demo clip opens as needs review; the model result stays", () => {
  const saved = {
    id: "inc-demo",
    source: "demo",
    status: "RESOLVED_CONFIRMED",
    reviewed_at: "2026-10-09T13:51:00Z",
    review_reason: "concealed",
    review_note: "bag",
    model: "gemini-3.5-flash-lite",
  };
  const opened = openForReview(saved);
  assert.equal(opened.status, "NEEDS_REVIEW");
  assert.equal(opened.reviewed_at, null);
  assert.equal(opened.review_reason, null);
  assert.equal(opened.model, "gemini-3.5-flash-lite");
  assert.equal(openForReview({ ...saved, source: "seed" }).status, "RESOLVED_CONFIRMED");
  assert.equal(openForReview({ ...saved, status: "NEEDS_REVIEW" }).status, "NEEDS_REVIEW");
});

test("demo-clip incidents are hidden unless demo mode is on", () => {
  const items = [{ id: "a", source: "live" }, { id: "b", source: "demo" }, { id: "c", source: "seed" }];
  assert.deepEqual(forDemoMode(items, false).map((i) => i.id), ["a", "c"]);
  assert.deepEqual(forDemoMode(items, true).map((i) => i.id), ["a", "b", "c"]);
});

test("a looping clip alerts once per session, when it first reaches the analysed moment", () => {
  let seen: DemoSighting[] = [];
  assert.equal(shouldAlert(seen, "demo/floor/a.mp4", 4.2, 1.0), false);
  assert.equal(shouldAlert(seen, "demo/floor/a.mp4", 4.2, 4.3), true);
  seen = addSighting(seen, { clip: "demo/floor/a.mp4", incidentId: "inc-a", verdict: "CONCEALMENT", at: 1 });
  // the next loop, or another tile with the same clip, stays quiet and adds nothing
  assert.equal(shouldAlert(seen, "demo/floor/a.mp4", 4.2, 4.3), false);
  assert.equal(addSighting(seen, { clip: "demo/floor/a.mp4", incidentId: "inc-a", verdict: "CONCEALMENT", at: 2 }), seen);
  assert.equal(shouldAlert(seen, "demo/floor/b.mp4", 0, 0), true);
});

test("playback lists only demo incidents the wall flagged, newest first; benign ones stay on the tile", () => {
  const incidents = [
    { id: "live-1", source: "live" },
    { id: "inc-a", source: "demo" },
    { id: "inc-b", source: "demo" },
    { id: "inc-c", source: "demo" },
    { id: "seed-1", source: "seed" },
  ];
  let seen: DemoSighting[] = [];
  seen = addSighting(seen, { clip: "a", incidentId: "inc-a", verdict: "CONCEALMENT", at: 100 });
  seen = addSighting(seen, { clip: "c", incidentId: "inc-c", verdict: "BENIGN", at: 150 });
  seen = addSighting(seen, { clip: "b", incidentId: "inc-b", verdict: "SCAN_AVOIDANCE", at: 200 });

  const { items, seenAt } = withSightings(incidents, seen);

  assert.deepEqual(items.map((i) => i.id), ["inc-b", "inc-a", "live-1", "seed-1"]);
  assert.equal(seenAt.get("inc-b"), 200);
  assert.equal(seenAt.has("inc-c"), false);
});

test("demo results older than the newest-incidents window are still listed, once", () => {
  const live = [{ id: "live-1" }, { id: "inc-a" }];
  const demo = [{ id: "inc-a" }, { id: "inc-old" }];
  assert.deepEqual(withDemoIncidents(live, demo).map((i) => i.id), ["live-1", "inc-a", "inc-old"]);
});
