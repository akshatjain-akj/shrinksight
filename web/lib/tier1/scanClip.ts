"use client";

/**
 * Investigate's optional Tier-1 screening: steps through an uploaded clip on this device and runs the Live edge
 * tracker and gate on it, faster than real time where the laptop allows. Nothing leaves the browser.
 */

import { openVideo, seek } from "../frames";
import type { Rule } from "../types";
import { Tier1Engine, type EdgeTuning } from "./engine.ts";
import type { Pt, ZoneShape } from "./geometry.ts";
import { PoseSmoother } from "./oneEuro.ts";
import { posePeople } from "./people.ts";
import { ClipScreen, SAMPLE_MS, type ScreenResult } from "./screen.ts";
import { handRect } from "./stills.ts";
import { PersonTracker } from "./tracks.ts";
import { loadPose } from "./vision.ts";

export interface ScanOptions {
  cameraKind: "checkout" | "floor";
  zones: ZoneShape[];
  rules: Rule[];
  tuning: EdgeTuning;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface ScanResult extends ScreenResult {
  /** Hand close-ups (from the original video) at the reach and the possible hide, when wrists were visible. */
  hands: { label: "hand_reach" | "hand_hold"; blob: Blob }[];
  seconds: number;
}

const HAND_SIDE = 384;

export async function scanClip(url: string, options: ScanOptions): Promise<ScanResult> {
  const video = await openVideo(url);
  const pose = await loadPose();
  try {
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    if (!duration) throw new Error("couldn’t read the clip’s length");
    const tracker = new PersonTracker(() => new Tier1Engine(options.cameraKind, options.zones, options.rules));
    tracker.setTuning(options.tuning);
    // Checkout: after a real signal, the shopper leaving the lane also opens the gate (Live edge's default).
    tracker.setLaneLeave(options.cameraKind === "checkout");
    const screen = new ClipScreen(tracker);
    const smoother = new PoseSmoother();
    const wrists = new Map<number, Pt[]>();
    const totalMs = Math.floor(duration * 1000);

    for (let tMs = 0; tMs <= totalMs; tMs += SAMPLE_MS) {
      if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      await seek(video, tMs / 1000);
      // VIDEO mode needs rising timestamps; clip time is exactly that.
      const found = pose.detectForVideo(video, tMs + 1).landmarks ?? [];
      const people = posePeople(smoother.smooth(found, tMs), tMs);
      const first = people[0]?.sample;
      const points = [first?.leftWrist, first?.rightWrist].filter((p): p is Pt => Boolean(p));
      if (points.length) wrists.set(tMs, points);
      screen.feed(tMs, people);
      options.onProgress?.(Math.min(1, tMs / totalMs));
    }

    const result = screen.result();
    const hands: ScanResult["hands"] = [];
    const used = new Set<number>();
    const moments = [
      ["hand_reach", result.reachAtMs],
      ["hand_hold", result.holdAtMs],
    ] as const;
    for (const [label, atMs] of moments) {
      const at = atMs == null ? null : nearestSample(wrists, atMs);
      if (at == null || used.has(at)) continue; // never the same frame twice
      used.add(at);
      const blob = await handShot(video, at, wrists.get(at)!);
      if (blob) hands.push({ label, blob });
    }
    return { ...result, hands, seconds: duration };
  } finally {
    pose.close();
    video.removeAttribute("src");
    video.load();
  }
}

/** The sampled time with visible wrists closest to atMs (within 600 ms). */
function nearestSample(wrists: Map<number, Pt[]>, atMs: number): number | null {
  let best: number | null = null;
  for (const t of wrists.keys()) {
    if (Math.abs(t - atMs) <= 600 && (best == null || Math.abs(t - atMs) < Math.abs(best - atMs))) best = t;
  }
  return best;
}

async function handShot(video: HTMLVideoElement, tMs: number, points: Pt[]): Promise<Blob | null> {
  await seek(video, tMs / 1000);
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  const short = Math.min(w, h);
  const crop = handRect(points.map((p) => ({ x: p.x * w, y: p.y * h })), w, h, short * 0.25, short * 0.08);
  if (!crop) return null;
  const canvas = document.createElement("canvas");
  canvas.width = HAND_SIDE;
  canvas.height = HAND_SIDE;
  canvas.getContext("2d")?.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, HAND_SIDE, HAND_SIDE);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
}
