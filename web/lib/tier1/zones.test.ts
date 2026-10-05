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
