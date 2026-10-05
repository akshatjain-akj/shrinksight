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
}

/** The frame used for marking zones: half a second in, so the first black frame is skipped. */
export async function firstFrame(url: string): Promise<Frame> {
  const video = await openVideo(url);
  await seek(video, Math.min(0.5, (video.duration || 1) / 4));
  const canvas = canvasFor(video);
  canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await toJpeg(canvas, 0.8);
  video.removeAttribute("src");
  return { blob, dataUrl: canvas.toDataURL("image/jpeg", 0.8), width: canvas.width, height: canvas.height };
}

/** Four evenly spaced stills with the zone outlines drawn on, ready for the stills upload. */
export async function markedStills(url: string, zones: ZoneShape[]): Promise<MarkedStill[]> {
  const video = await openVideo(url);
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 4;
  const canvas = canvasFor(video);
  const ctx = canvas.getContext("2d")!;
  const stills: MarkedStill[] = [];
  for (const [index, fraction] of [0.15, 0.4, 0.65, 0.9].entries()) {
    await seek(video, duration * fraction);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    if (zones.length) {
      drawZoneOutlines(ctx, zones, (p) => [p.x * canvas.width, p.y * canvas.height], canvas.width / 720);
    }
    stills.push({ label: STILL_LABELS[index], blob: await toJpeg(canvas, 0.7) });
  }
  video.removeAttribute("src");
  return stills;
}
