"use client";

/**
 * Shrinks a clip before upload: re-encodes it to ~720p at ~1.5 Mbps with the browser's own MediaRecorder.
 * Gemini analyses video at low resolution anyway, so this loses no useful detail for the verdict, while a
 * 14 MB phone clip typically becomes ~2 MB: a much faster upload and no Files API detour on the server.
 * (Close-up stills are still cropped from the full-resolution original.) Runs in real time, about as long as
 * the clip, and falls back to the original whenever anything is unsupported or the result isn't smaller.
 */

import type { ZoneShape } from "./tier1/geometry";
import { drawZoneOutlines, type Rect } from "./tier1/zones";

const MIN_BYTES_TO_SHRINK = 4 * 1024 * 1024;
const TARGET_HEIGHT = 720;
const BITRATE = 1_500_000;
const MIME_PREFERENCE = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
};

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return MIME_PREFERENCE.find((m) => MediaRecorder.isTypeSupported(m));
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export interface ShrinkOptions {
  /** Crop to this part of the frame (normalised). Items get far more pixels in every frame Gemini watches. */
  crop?: Rect | null;
  /** Zone outlines drawn into the video, matching the stills and Live edge. */
  zones?: ZoneShape[];
}

export interface ShrinkResult {
  blob: Blob;
  /** The crop actually applied, or null if the original (or an uncropped re-encode) is being sent. */
  crop: Rect | null;
}

export async function shrinkClip(
  original: Blob,
  onProgress?: (fraction: number) => void,
  options: ShrinkOptions = {},
): Promise<ShrinkResult> {
  const mime = pickMime();
  const canCapture = typeof HTMLCanvasElement !== "undefined" && "captureStream" in HTMLCanvasElement.prototype;
  const crop = options.crop ?? null;
  const zones = options.zones ?? [];
  const unchanged: ShrinkResult = { blob: original, crop: null };
  // Small clips are only re-encoded when cropping is worth it; otherwise they're sent as they are.
  if (!mime || !canCapture || (original.size < MIN_BYTES_TO_SHRINK && !crop)) return unchanged;

  const url = URL.createObjectURL(original);
  const video = document.createElement("video") as FrameVideo;
  try {
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("unreadable video"));
    });
    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    const area = crop ?? { x: 0, y: 0, w: 1, h: 1 };
    const sx = area.x * vw;
    const sy = area.y * vh;
    const sw = area.w * vw;
    const sh = area.h * vh;
    // Never upscale; cap at ~720p. A crop keeps native pixels, which is the whole point.
    const scale = Math.min(1, TARGET_HEIGHT / sh, 1280 / sw);
    const canvas = document.createElement("canvas");
    canvas.width = even(sw * scale);
    canvas.height = even(sh * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return unchanged;
    const toCanvas = (p: { x: number; y: number }): [number, number] => [
      ((p.x - area.x) / area.w) * canvas.width,
      ((p.y - area.y) / area.h) * canvas.height,
    ];
    const paint = () => {
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      if (zones.length) drawZoneOutlines(ctx, zones, toCanvas, canvas.width / 720);
    };

    const chunks: BlobPart[] = [];
    const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: mime, videoBitsPerSecond: BITRATE });
    recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));

    let active = true;
    const draw = () => {
      if (!active) return;
      paint();
      if (Number.isFinite(video.duration) && video.duration > 0) onProgress?.(Math.min(1, video.currentTime / video.duration));
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(draw);
      else requestAnimationFrame(draw);
    };

    paint();
    recorder.start(250);
    const ended = new Promise<void>((resolve) => (video.onended = () => resolve()));
    await video.play();
    draw();
    // Safety net: never wait much longer than the clip itself.
    const limitMs = (Number.isFinite(video.duration) ? video.duration : 30) * 1500 + 5000;
    await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, limitMs))]);
    active = false;
    recorder.stop();
    await stopped;
    onProgress?.(1);

    const shrunk = new Blob(chunks, { type: mime.split(";")[0] });
    if (!shrunk.size) return unchanged;
    // A crop is worth sending even if it isn't much smaller; a plain re-encode must actually save space.
    if (crop) return shrunk.size < original.size * 1.5 ? { blob: shrunk, crop } : unchanged;
    return shrunk.size < original.size * 0.9 ? { blob: shrunk, crop: null } : unchanged;
  } catch {
    return unchanged;
  } finally {
    video.pause();
    video.removeAttribute("src");
    URL.revokeObjectURL(url);
  }
}
