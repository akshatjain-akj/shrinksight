"use client";

import type { MarkedStill } from "./api";
import type { ZoneShape } from "./tier1/geometry";
import { drawZoneOutlines } from "./tier1/zones";

const MAX_WIDTH = 720;
const STILL_LABELS: MarkedStill["label"][] = ["before", "reach", "hold", "after"];

function once(target: EventTarget, event: string, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    target.addEventListener(event, () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function openVideo(url: string): Promise<HTMLVideoElement> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  await once(video, "loadeddata");
  // Browser-recorded WebM often reports an infinite duration until you seek past the end.
  if (!Number.isFinite(video.duration)) {
    video.currentTime = 1e9;
    await once(video, "durationchange").catch(() => undefined);
    video.currentTime = 0;
    await once(video, "seeked").catch(() => undefined);
  }
  return video;
}

async function seek(video: HTMLVideoElement, t: number): Promise<void> {
  if (Math.abs(video.currentTime - t) < 0.01) return;
  video.currentTime = t;
  await once(video, "seeked");
}

function canvasFor(video: HTMLVideoElement): HTMLCanvasElement {
  const scale = Math.min(1, MAX_WIDTH / (video.videoWidth || MAX_WIDTH));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round((video.videoWidth || MAX_WIDTH) * scale);
  canvas.height = Math.round((video.videoHeight || MAX_WIDTH * 0.5625) * scale);
  return canvas;
}

function toJpeg(canvas: HTMLCanvasElement, quality = 0.75): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not encode frame"))), "image/jpeg", quality),
  );
}

export interface Frame {
  blob: Blob;
  dataUrl: string;
  width: number;
  height: number;
  /** Clip length in seconds, if the browser could tell. */
  duration: number | null;
}

/** The frame used for marking zones: half a second in, so the first black frame is skipped. */
export async function firstFrame(url: string): Promise<Frame> {
  const video = await openVideo(url);
  await seek(video, Math.min(0.5, (video.duration || 1) / 4));
  const canvas = canvasFor(video);
  canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await toJpeg(canvas, 0.8);
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
  video.removeAttribute("src");
  return { blob, dataUrl: canvas.toDataURL("image/jpeg", 0.8), width: canvas.width, height: canvas.height, duration };
}

// The item pile gets the biggest close-up: it is where Gemini counts every item, including flat or thin ones.
const CLOSE_UPS: { kind: string; label: MarkedStill["label"]; atIndex: number; maxWidth: number }[] = [
  { kind: "pickup", label: "pickup_start", atIndex: 0, maxWidth: 1024 },
  { kind: "scanner", label: "scanner_mid", atIndex: 1, maxWidth: 640 },
  { kind: "bagging", label: "bagging_end", atIndex: 3, maxWidth: 640 },
];

/** A sharp crop of one zone from the full-resolution video (up to 2× zoom). */
function zoneCrop(video: HTMLVideoElement, zone: ZoneShape, maxWidth: number): HTMLCanvasElement | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh || zone.polygon.length < 3) return null;
  const xs = zone.polygon.map((p) => p.x * vw);
  const ys = zone.polygon.map((p) => p.y * vh);
  const padX = (Math.max(...xs) - Math.min(...xs)) * 0.15;
  const padY = (Math.max(...ys) - Math.min(...ys)) * 0.15;
  const sx = Math.max(0, Math.min(...xs) - padX);
  const sy = Math.max(0, Math.min(...ys) - padY);
  const sw = Math.min(vw - sx, Math.max(...xs) - Math.min(...xs) + padX * 2);
  const sh = Math.min(vh - sy, Math.max(...ys) - Math.min(...ys) + padY * 2);
  if (sw < 16 || sh < 16) return null;
  const scale = Math.min(2, maxWidth / sw);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  canvas.getContext("2d")!.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Four evenly spaced stills with the zone outlines drawn on, plus close-ups of the marked item pile (start),
 * scanner (mid) and bagging area (end). Close-ups reuse the same four seeks, so they cost almost nothing.
 */
export async function markedStills(url: string, zones: ZoneShape[]): Promise<MarkedStill[]> {
  const video = await openVideo(url);
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 4;
  const canvas = canvasFor(video);
  const ctx = canvas.getContext("2d")!;
  const stills: MarkedStill[] = [];
  const closeUps: MarkedStill[] = [];
  for (const [index, fraction] of [0.15, 0.4, 0.65, 0.9].entries()) {
    await seek(video, duration * fraction);
    for (const want of CLOSE_UPS.filter((c) => c.atIndex === index)) {
      const zone = zones.find((z) => z.kind === want.kind);
      const crop = zone ? zoneCrop(video, zone, want.maxWidth) : null;
      if (crop) closeUps.push({ label: want.label, blob: await toJpeg(crop, want.kind === "pickup" ? 0.85 : 0.8) });
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    if (zones.length) {
      drawZoneOutlines(ctx, zones, (p) => [p.x * canvas.width, p.y * canvas.height], canvas.width / 720);
    }
    stills.push({ label: STILL_LABELS[index], blob: await toJpeg(canvas, 0.7) });
  }
  video.removeAttribute("src");
  return [...stills, ...closeUps];
}
