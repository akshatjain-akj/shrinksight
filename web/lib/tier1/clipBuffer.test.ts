import assert from "node:assert/strict";
import test from "node:test";
import { ClipBuffer, type Clock, type Segment } from "./clipBuffer.ts";

/** A clock whose timers only fire when the test advances time. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id as number),
  };
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await Promise.resolve();
    }
    now = until;
    await new Promise((r) => setImmediate(r));
  };
  return { clock, advance, timers };
}

/** Recorders that remember when they started and stopped; the "file" names its start time. */
function fakeRecorders(clock: Clock) {
  const log: { startedAt: number; stoppedAt: number | null }[] = [];
  const start = (): Segment => {
    const entry = { startedAt: clock.now(), stoppedAt: null as number | null };
    log.push(entry);
    return {
      stop: async () => {
        entry.stoppedAt = clock.now();
        return new Blob([`from ${entry.startedAt}`]);
      },
    };
  };
  return { start, log };
}

test("two recorders take turns, so there is never more than two running", async () => {
  const { clock, advance } = fakeClock();
  const rec = fakeRecorders(clock);
  const buffer = new ClipBuffer(rec.start, { segmentMs: 8000, clock });
  buffer.begin();
  await advance(30_000);
  const running = rec.log.filter((r) => r.stoppedAt === null);
  assert.equal(running.length, 2);
  assert.deepEqual(rec.log.slice(0, 3).map((r) => r.startedAt), [0, 4000, 8000]);
  buffer.close();
  assert.equal(rec.log.filter((r) => r.stoppedAt === null).length, 0);
});

test("a claim returns one complete recording: the history before the trigger plus postMs after", async () => {
  const { clock, advance } = fakeClock();
  const rec = fakeRecorders(clock);
  const buffer = new ClipBuffer(rec.start, { segmentMs: 8000, clock });
  buffer.begin();
  await advance(21_000); // recorders started at 16 000 and 20 000

  const pending = buffer.claim(3500);
  await advance(3500);
  const clip = await pending;

  assert.ok(clip);
  assert.equal(await clip.blob.text(), "from 16000", "the recorder with the most history, from its very start");
  assert.equal(clip.startMs, 16_000);
  assert.equal(clip.endMs, 24_500);
});

test("a claimed recorder is not restarted mid-claim, and the buffer keeps recording afterwards", async () => {
  const { clock, advance } = fakeClock();
  const rec = fakeRecorders(clock);
  const buffer = new ClipBuffer(rec.start, { segmentMs: 8000, clock });
  buffer.begin();
  await advance(7000);
  const pending = buffer.claim(3500); // would normally restart at 8000
  await advance(3500);
  const clip = await pending;
  assert.equal(clip!.startMs, 0);
  assert.equal(clip!.endMs, 10_500);
  await advance(20_000);
  assert.equal(rec.log.filter((r) => r.stoppedAt === null).length, 2);
});

test("a recorder that only just restarted is skipped when the other has more history", async () => {
  const { clock, advance } = fakeClock();
  const rec = fakeRecorders(clock);
  const buffer = new ClipBuffer(rec.start, { segmentMs: 8000, minHistoryMs: 2000, clock });
  buffer.begin();
  await advance(12_500); // slot A restarted at 8000, slot B started at 4000 and restarts at 12000
  const pending = buffer.claim(1000);
  await advance(1000);
  assert.equal((await pending)!.startMs, 8000);
});

test("two quick triggers get one clip each; a third gets none until one is free", async () => {
  const { clock, advance } = fakeClock();
  const rec = fakeRecorders(clock);
  const buffer = new ClipBuffer(rec.start, { segmentMs: 8000, clock });
  buffer.begin();
  await advance(6000);
  const first = buffer.claim(3000);
  const second = buffer.claim(3000);
  assert.equal(await buffer.claim(3000), null);
  await advance(3000);
  assert.ok(await first);
  assert.ok(await second);
});
