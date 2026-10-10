import assert from "node:assert/strict";
import test from "node:test";
import { fitPlayer } from "./player.ts";

test("landscape clips fill the panel; portrait clips get a narrower, centred player", () => {
  assert.deepEqual(fitPlayer(16 / 9), { aspectRatio: "1.7778", width: "min(100%, 124.44vh)", marginInline: "auto" });
  assert.deepEqual(fitPlayer(9 / 16), { aspectRatio: "0.5625", width: "min(100%, 39.38vh)", marginInline: "auto" });
});

test("an unknown shape falls back to 16:9 and extreme shapes are kept sane", () => {
  assert.equal(fitPlayer(null).aspectRatio, "1.7778");
  assert.equal(fitPlayer(0).aspectRatio, "1.7778");
  assert.equal(fitPlayer(10).aspectRatio, "4");
});
