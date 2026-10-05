"use client";

/**
 * Shrinks a clip before upload: re-encodes it to ~720p at ~1.5 Mbps with the browser's own MediaRecorder.
 * Gemini analyses video at low resolution anyway, so this loses no useful detail for the verdict, while a
 * 14 MB phone clip typically becomes ~2 MB: a much faster upload and no Files API detour on the server.
 * (Close-up stills are still cropped from the full-resolution original.) Runs in real time, about as long as
 * the clip, and falls back to the original whenever anything is unsupported or the result isn't smaller.
 */

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

export async function shrinkClip(original: Blob, onProgress?: (fraction: number) => void): Promise<Blob> {
  const mime = pickMime();
  const canCapture = typeof HTMLCanvasElement !== "undefined" && "captureStream" in HTMLCanvasElement.prototype;
  if (original.size < MIN_BYTES_TO_SHRINK || !mime || !canCapture) return original;

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
    const scale = Math.min(1, TARGET_HEIGHT / (video.videoHeight || TARGET_HEIGHT));
    const canvas = document.createElement("canvas");
    canvas.width = even((video.videoWidth || 1280) * scale);
    canvas.height = even((video.videoHeight || 720) * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return original;

    const chunks: BlobPart[] = [];
    const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: mime, videoBitsPerSecond: BITRATE });
    recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));

    let active = true;
    const draw = () => {
      if (!active) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      if (Number.isFinite(video.duration) && video.duration > 0) onProgress?.(Math.min(1, video.currentTime / video.duration));
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(draw);
      else requestAnimationFrame(draw);
    };

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
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
    return shrunk.size > 0 && shrunk.size < original.size * 0.9 ? shrunk : original;
  } catch {
    return original;
  } finally {
    video.pause();
    video.removeAttribute("src");
    URL.revokeObjectURL(url);
  }
}
