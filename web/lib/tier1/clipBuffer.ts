/**
 * Always-playable clips from a live canvas: two recorders take turns.
 *
 * A WebM file only plays from its start (header + first keyframe), and the browser's recorder writes keyframes
 * rarely, so cutting old seconds out of one long recording leaves video Gemini can't decode. Instead two recorders
 * run staggered by half a segment and each restarts every `segmentMs`. At any moment the older one holds a complete
 * file with between segmentMs/2 and segmentMs of history. When the gate opens it is claimed: it keeps recording for
 * `postMs`, then stops and its whole file is the clip (history before the trigger + what happened after).
 */

export interface Segment {
  stop(): Promise<Blob>;
}

export type StartSegment = () => Segment;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface Clip {
  blob: Blob;
  /** Clock times (ms) the clip starts and ends at. */
  startMs: number;
  endMs: number;
}

interface Slot {
  segment: Segment | null;
  startedAt: number;
  timer: unknown;
  claimed: boolean;
}

const browserClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id as number),
};

export class ClipBuffer {
  private readonly start: StartSegment;
  private readonly segmentMs: number;
  private readonly minHistoryMs: number;
  private readonly clock: Clock;
  private readonly slots: Slot[] = [];
  private staggerTimer: unknown = null;
  private closed = false;

  constructor(start: StartSegment, options: { segmentMs?: number; minHistoryMs?: number; clock?: Clock } = {}) {
    this.start = start;
    this.segmentMs = options.segmentMs ?? 8000;
    this.minHistoryMs = options.minHistoryMs ?? 2000;
    this.clock = options.clock ?? browserClock;
  }

  /** Starts the first recorder now and the second half a segment later. */
  begin(): void {
    this.slots.push(this.fresh());
    this.staggerTimer = this.clock.setTimeout(() => {
      if (!this.closed) this.slots.push(this.fresh());
    }, this.segmentMs / 2);
  }

  /**
   * Reserves the recorder with the most history, records `postMs` more, and resolves with its complete file.
   * Null if both recorders are already claimed (two triggers in quick succession) or the buffer was closed.
   */
  claim(postMs: number): Promise<Clip | null> {
    const now = this.clock.now();
    const open = this.slots.filter((slot) => !slot.claimed && slot.segment);
    if (!open.length || this.closed) return Promise.resolve(null);
    // Oldest first, but not one that only just restarted if another has enough history.
    const ranked = [...open].sort((a, b) => a.startedAt - b.startedAt);
    const slot = ranked.find((s) => now - s.startedAt >= this.minHistoryMs) ?? ranked[0];
    slot.claimed = true;
    this.clock.clearTimeout(slot.timer);
    return new Promise((resolve) => {
      slot.timer = this.clock.setTimeout(() => {
        const segment = slot.segment!;
        const startMs = slot.startedAt;
        const endMs = this.clock.now();
        // Keep the buffer going: this slot records afresh right away.
        slot.claimed = false;
        if (this.closed) {
          slot.segment = null;
          slot.timer = null;
        } else {
          this.renew(slot);
        }
        void segment.stop().then(
          (blob) => resolve(blob.size ? { blob, startMs, endMs } : null),
          () => resolve(null),
        );
      }, postMs);
    });
  }

  close(): void {
    this.closed = true;
    this.clock.clearTimeout(this.staggerTimer);
    for (const slot of this.slots) {
      if (slot.claimed) continue; // a claimed recording still finishes and is delivered
      this.clock.clearTimeout(slot.timer);
      void slot.segment?.stop();
      slot.segment = null;
    }
  }

  private fresh(): Slot {
    const slot: Slot = { segment: null, startedAt: 0, timer: null, claimed: false };
    this.renew(slot);
    return slot;
  }

  /** A new recording in this slot, restarted again after a segment unless it gets claimed. */
  private renew(slot: Slot): void {
    slot.segment = this.start();
    slot.startedAt = this.clock.now();
    slot.timer = this.clock.setTimeout(() => {
      if (this.closed || slot.claimed) return;
      const old = slot.segment;
      // The new recorder starts before the old one stops, so there is never a gap.
      this.renew(slot);
      void old?.stop();
    }, this.segmentMs);
  }
}

/** Recorders on a canvas (the face-blurred picture). Browser only. */
export function canvasSegments(canvas: HTMLCanvasElement, fps: number, bitsPerSecond: number): StartSegment {
  const mime = ["video/webm;codecs=vp8", "video/webm", "video/mp4"].find(
    (m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m),
  );
  return () => {
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(
      canvas.captureStream(fps),
      mime ? { mimeType: mime, videoBitsPerSecond: bitsPerSecond } : undefined,
    );
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.start(1000);
    const type = () => (recorder.mimeType || mime || "video/webm").split(";")[0];
    return {
      stop: () =>
        new Promise<Blob>((resolve) => {
          if (recorder.state === "inactive") {
            resolve(new Blob(chunks, { type: type() }));
            return;
          }
          recorder.addEventListener("stop", () => resolve(new Blob(chunks, { type: type() })), { once: true });
          recorder.stop();
        }),
    };
  };
}
