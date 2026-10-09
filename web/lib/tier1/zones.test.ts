import assert from "node:assert/strict";
import test from "node:test";
import { rect, type ZoneShape } from "./geometry.ts";
import { applySuggestions, boxToPolygon, shapesToHints } from "./zones.ts";

const shapes: ZoneShape[] = [
  { id: "z-scan-1", name: "Scanner", kind: "scanner", polygon: rect(0.1, 0.1, 0.2, 0.2) },
  { id: "z-bag-1", name: "Bagging", kind: "bagging", polygon: rect(0.6, 0.3, 0.3, 0.4) },
];

test("Gemini box_2d becomes a normalised rectangle", () => {
  assert.deepEqual(boxToPolygon([500, 400, 700, 600]), [
    { x: 0.4, y: 0.5 },
    { x: 0.6, y: 0.5 },
    { x: 0.6, y: 0.7 },
    { x: 0.4, y: 0.7 },
  ]);
});

test("out-of-range boxes are clamped to the frame", () => {
  const poly = boxToPolygon([-50, 900, 400, 1200]);
  assert.ok(poly.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1));
});

test("shapes become API hints with rounded points and descriptions", () => {
  const hints = shapesToHints(shapes, { "z-scan-1": "white paper square" });
  assert.equal(hints.length, 2);
  assert.equal(hints[0].zone_id, "z-scan-1");
  assert.equal(hints[0].kind, "scanner");
  assert.equal(hints[0].description, "white paper square");
  assert.equal(hints[1].description, "");
  assert.ok(hints[0].polygon.every((p) => Number.isInteger(p.x * 1000)));
});

test("suggestions update found zones and keep the rest", () => {
  const out = applySuggestions(shapes, {}, [
    { zone_id: "z-scan-1", found: true, box_2d: [500, 400, 700, 600], description: "paper square" },
    { zone_id: "z-bag-1", found: false, box_2d: [], description: "" },
  ]);
  assert.deepEqual(out.found, ["z-scan-1"]);
  assert.deepEqual(out.missing, ["z-bag-1"]);
  assert.deepEqual(out.shapes[0].polygon, boxToPolygon([500, 400, 700, 600]));
  assert.deepEqual(out.shapes[1].polygon, shapes[1].polygon);
  assert.equal(out.descriptions["z-scan-1"], "paper square");
});

test("action crop covers the zones with a margin, or nothing when it would keep most of the frame", async () => {
  const { actionCrop, rectToBox } = await import("./zones.ts");
  const counter = [
    { id: "z-scan-1", name: "Scanner", kind: "scanner", polygon: rect(0.3, 0.4, 0.1, 0.1) },
    { id: "z-bag-1", name: "Bagging", kind: "bagging", polygon: rect(0.45, 0.4, 0.1, 0.15) },
  ];
  const crop = actionCrop(counter);
  assert.ok(crop, "a small counter area should be cropped");
  assert.ok(crop.x < 0.3 && crop.x + crop.w > 0.55 && crop.y < 0.4 && crop.y + crop.h > 0.55);
  assert.equal(actionCrop(shapes), null, "zones already covering most of the frame: no crop");
  assert.deepEqual(rectToBox({ x: 0.1, y: 0.2, w: 0.5, h: 0.4 }), [200, 100, 600, 600]);
  const whole = [{ id: "big", name: "Big", kind: "shelf", polygon: rect(0.05, 0.05, 0.9, 0.9) }];
  assert.equal(actionCrop(whole), null);
  assert.equal(actionCrop([]), null);
});

test("zones saved with a demo clip land on this camera's zones by id, else by kind", async () => {
  const { applyHints } = await import("./zones.ts");
  const square = [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.1 }, { x: 0.3, y: 0.3 }];
  const shapes = [
    { id: "z-scan-2", kind: "scanner", polygon: [] },
    { id: "z-bag-2", kind: "bagging", polygon: [] },
    { id: "z-pick-2", kind: "pickup", polygon: [] },
  ] as unknown as Parameters<typeof applyHints>[0];
  const hints = [
    { zone_id: "z-scan-1", kind: "scanner" as const, polygon: square, description: "paper square" },
    { zone_id: "z-bag-2", kind: "bagging" as const, polygon: square, description: "" },
  ];

  const out = applyHints(shapes, {}, hints);

  assert.deepEqual(out.placed, ["z-scan-2", "z-bag-2"]);
  assert.equal(out.descriptions["z-scan-2"], "paper square");
  assert.equal(out.shapes[2].polygon.length, 0);
});
