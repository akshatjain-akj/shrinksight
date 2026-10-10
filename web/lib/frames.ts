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

export async function openVideo(url: string): Promise<HTMLVideoElement> {
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

export async function seek(video: HTMLVideoElement, t: number): Promise<void> {
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
  /** Where in the clip the frame was taken (seconds). */
  time: number;
  /**
   * The browser plays the clip but drew no picture of it (seen on Android Chrome with some phone clips). The zone
   * marker then shows the clip itself instead, and Gemini can't be asked to suggest zones from this frame.
   */
  blank: boolean;
}

/** The frame used for marking zones: half a second in, so the first black frame is skipped. */
export async function firstFrame(url: string): Promise<Frame> {
  const video = await openVideo(url);
  const time = Math.min(0.5, (video.duration || 1) / 4);
  await seek(video, time);
  const canvas = canvasFor(video);
  canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
  video.removeAttribute("src");
  // Only a black frame takes the phone path below; every other clip is read exactly as before.
  if (isBlank(canvas)) {
    const retried = await frameInPage(url, duration).catch(() => null);
    if (retried) return retried;
  }
  const blob = await toJpeg(canvas, 0.8);
  return {
    blob,
    dataUrl: canvas.toDataURL("image/jpeg", 0.8),
    width: canvas.width,
    height: canvas.height,
    duration,
    time,
    blank: isBlank(canvas),
  };
}

/** True when a drawn frame is (almost) all black: the browser gave us no picture. */
function isBlank(canvas: HTMLCanvasElement): boolean {
  try {
    const probe = document.createElement("canvas");
    probe.width = 16;
    probe.height = 16;
    const ctx = probe.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(canvas, 0, 0, 16, 16);
    const data = ctx.getImageData(0, 0, 16, 16).data;
    for (let i = 0; i < data.length; i += 4) if (Math.max(data[i], data[i + 1], data[i + 2]) >= 12) return false;
    return true;
  } catch {
    return false;
  }
}

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
};

/** Resolves once the frame at the current time is decoded (or after a short wait where that can't be told). */
function frameDrawn(video: HTMLVideoElement): Promise<void> {
  const v = video as FrameVideo;
  if (!v.requestVideoFrameCallback) return new Promise((resolve) => setTimeout(resolve, 150));
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 400);
    v.requestVideoFrameCallback!(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Fallback for a black first frame. Mobile browsers often don't decode a detached video that never played, so this
 * one is put in the page (invisible), played for a moment, and read only once each frame is really drawn. Tries a
 * few moments of the clip; null if every one is still black.
 */
async function frameInPage(url: string, duration: number | null): Promise<Frame | null> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.preload = "auto";
  video.setAttribute("aria-hidden", "true");
  video.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1";
  document.body.appendChild(video);
  try {
    video.src = url;
    await once(video, "loadeddata");
    await video.play().catch(() => undefined);
    video.pause();
    const length = duration ?? 4;
    const canvas = canvasFor(video);
    const ctx = canvas.getContext("2d")!;
    for (const t of [...new Set([Math.min(0.5, length / 4), Math.min(1, length / 2), length * 0.25])]) {
      const drawn = frameDrawn(video);
      video.currentTime = t;
      await once(video, "seeked");
      await drawn;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      if (isBlank(canvas)) continue;
      const blob = await toJpeg(canvas, 0.8);
      return { blob, dataUrl: canvas.toDataURL("image/jpeg", 0.8), width: canvas.width, height: canvas.height, duration, time: t, blank: false };
    }
    return null;
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
  }
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
export async function markedStills(
  url: string,
  zones: ZoneShape[],
  options: { skipPickup?: boolean } = {},
): Promise<MarkedStill[]> {
  const video = await openVideo(url);
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 4;
  const canvas = canvasFor(video);
  const ctx = canvas.getContext("2d")!;
  const stills: MarkedStill[] = [];
  const closeUps: MarkedStill[] = [];
  for (const [index, fraction] of [0.15, 0.4, 0.65, 0.9].entries()) {
    await seek(video, duration * fraction);
    for (const want of CLOSE_UPS.filter((c) => c.atIndex === index && !(options.skipPickup && c.kind === "pickup"))) {
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

// ---------- Item-pile views for the inventory call ----------

export interface PileViews {
  views: { label: "pile" | "left" | "right"; blob: Blob }[];
  /** The whole-pile view (enhanced). Inventory boxes are in its coordinates; numbered marks are drawn on it. */
  base: HTMLCanvasElement;
}

/** Brightens dark scenes a little so dark items (a black packet on a dark counter) stand out. */
function enhanceFilter(source: HTMLVideoElement, sx: number, sy: number, sw: number, sh: number): string {
  const probe = document.createElement("canvas");
  probe.width = 32;
  probe.height = 32;
  const pctx = probe.getContext("2d", { willReadFrequently: true })!;
  pctx.drawImage(source, sx, sy, sw, sh, 0, 0, 32, 32);
  const data = pctx.getImageData(0, 0, 32, 32).data;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  const mean = sum / (data.length / 4) / 255;
  const brightness = Math.min(1.6, Math.max(1, 0.5 / Math.max(mean, 0.05)));
  return `brightness(${brightness.toFixed(2)}) contrast(1.2)`;
}

function cropTo(video: HTMLVideoElement, sx: number, sy: number, sw: number, sh: number, maxWidth: number, filter: string) {
  const scale = Math.min(2, maxWidth / sw);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.filter = filter;
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Three views of the item pile from the full-resolution original at the start of the clip: the whole pile and
 * overlapping left/right halves zoomed in. Sent together in ONE inventory request.
 */
export async function pileViews(url: string, pile: ZoneShape): Promise<PileViews> {
  const video = await openVideo(url);
  try {
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 4;
    await seek(video, duration * 0.15);
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const xs = pile.polygon.map((p) => p.x * vw);
    const ys = pile.polygon.map((p) => p.y * vh);
    const padX = (Math.max(...xs) - Math.min(...xs)) * 0.15;
    const padY = (Math.max(...ys) - Math.min(...ys)) * 0.15;
    const sx = Math.max(0, Math.min(...xs) - padX);
    const sy = Math.max(0, Math.min(...ys) - padY);
    const sw = Math.min(vw - sx, Math.max(...xs) - Math.min(...xs) + padX * 2);
    const sh = Math.min(vh - sy, Math.max(...ys) - Math.min(...ys) + padY * 2);
    if (!vw || sw < 16 || sh < 16) throw new Error("item pile zone is too small");
    const filter = enhanceFilter(video, sx, sy, sw, sh);
    const base = cropTo(video, sx, sy, sw, sh, 1024, filter);
    const left = cropTo(video, sx, sy, sw * 0.6, sh, 1024, filter);
    const right = cropTo(video, sx + sw * 0.4, sy, sw * 0.6, sh, 1024, filter);
    return {
      base,
      views: [
        { label: "pile", blob: await toJpeg(base, 0.85) },
        { label: "left", blob: await toJpeg(left, 0.85) },
        { label: "right", blob: await toJpeg(right, 0.85) },
      ],
    };
  } finally {
    video.removeAttribute("src");
  }
}

/** The pile close-up with a numbered box per confirmed item (#1, #2, …), for the main investigation call. */
export async function numberedPile(base: HTMLCanvasElement, items: { box_2d: number[] }[]): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = base.width;
  canvas.height = base.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(base, 0, 0);
  const scale = canvas.width / 720;
  ctx.lineWidth = Math.max(2, 3 * scale);
  ctx.font = `800 ${Math.max(14, Math.round(18 * scale))}px system-ui, sans-serif`;
  ctx.textBaseline = "top";
  items.forEach((item, index) => {
    if (item.box_2d.length !== 4) return;
    const [ymin, xmin, ymax, xmax] = item.box_2d.map((n) => n / 1000);
    const x = xmin * canvas.width;
    const y = ymin * canvas.height;
    ctx.strokeStyle = "#f472b6";
    ctx.strokeRect(x, y, (xmax - xmin) * canvas.width, (ymax - ymin) * canvas.height);
    const label = `#${index + 1}`;
    const pad = 4 * scale;
    const w = ctx.measureText(label).width + pad * 2;
    ctx.fillStyle = "#f472b6";
    ctx.fillRect(x, y, w, Math.max(14, 18 * scale) + pad * 2);
    ctx.fillStyle = "#0b1220";
    ctx.fillText(label, x + pad, y + pad);
  });
  return toJpeg(canvas, 0.85);
}

export function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return toJpeg(canvas, 0.85);
}

/**
 * A photo of the scanning device, shrunk to at most 640 px on the long side as a JPEG (~30–80 KB). Low-quality phone
 * shots are fine: Gemini only needs to recognise the device.
 */
export async function scannerPhotoJpeg(file: Blob, maxSide = 640): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await toJpeg(canvas, 0.8);
  } finally {
    bitmap.close();
  }
}
