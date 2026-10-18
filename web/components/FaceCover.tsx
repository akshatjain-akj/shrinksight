"use client";

import { useEffect, useRef } from "react";
import { privacyBoxes, type PixelBox } from "@/lib/tier1/privacy";
import { loadPrivacy, type PrivacyModels } from "@/lib/tier1/vision";

/** Pixelates one face on the overlay canvas, which sits exactly on top of the video. */
function pixelateFace(ctx: CanvasRenderingContext2D, scratch: CanvasRenderingContext2D, video: HTMLVideoElement, face: PixelBox) {
  const padX = face.width * 0.25;
  const padY = face.height * 0.35;
  const sx = Math.max(0, face.originX - padX);
  const sy = Math.max(0, face.originY - padY);
  const sw = Math.min(video.videoWidth - sx, face.width + padX * 2);
  const sh = Math.min(video.videoHeight - sy, face.height + padY * 2);
  if (sw < 4 || sh < 4) return;
  scratch.canvas.width = Math.max(1, Math.round(sw / 14));
  scratch.canvas.height = Math.max(1, Math.round(sh / 14));
  scratch.drawImage(video, sx, sy, sw, sh, 0, 0, scratch.canvas.width, scratch.canvas.height);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(scratch.canvas, sx, sy, sw, sh);
  ctx.restore();
}

interface CoverJob {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  scratch: CanvasRenderingContext2D;
  seen: { ready: boolean };
}

const jobs: CoverJob[] = [];
let modelsPromise: Promise<PrivacyModels> | null = null;
let pumping = false;
let cursor = 0;

function draw(job: CoverJob, models: PrivacyModels) {
  const { video, canvas, ctx, scratch } = job;
  if (video.readyState < 2 || video.paused) return;
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const faces = (models.face.detect(video).detections ?? []).flatMap((d) =>
    d.boundingBox
      ? [{ originX: d.boundingBox.originX, originY: d.boundingBox.originY, width: d.boundingBox.width, height: d.boundingBox.height }]
      : [],
  );
  const poses = models.pose.detect(video).landmarks ?? [];
  ctx.clearRect(0, 0, width, height);
  for (const box of privacyBoxes(faces, poses, width, height)) pixelateFace(ctx, scratch, video, box);
  if (!job.seen.ready) {
    job.seen.ready = true;
    video.style.filter = "";
  }
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    modelsPromise ??= loadPrivacy();
    const models = await modelsPromise;
    while (jobs.length > 0) {
      const job = jobs[cursor % jobs.length];
      cursor += 1;
      try {
        draw(job, models);
      } catch {
        job.video.style.filter = "blur(18px)";
        job.seen.ready = false;
      }
      await new Promise((resolve) => setTimeout(resolve, 90));
    }
  } catch {
    modelsPromise = null;
    for (const job of jobs) job.video.style.filter = "blur(18px)";
    return;
  } finally {
    pumping = false;
  }
  if (jobs.length > 0) void pump();
}

function watch(job: CoverJob): () => void {
  jobs.push(job);
  void pump();
  return () => {
    const index = jobs.indexOf(job);
    if (index >= 0) jobs.splice(index, 1);
  };
}

/** Blurs faces on a camera tile that is not running the full live scan. */
export default function FaceCover({
  src,
  label,
  onTime,
}: {
  src: string;
  label: string;
  onTime?: (seconds: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const ctx = canvas.getContext("2d");
    const scratch = document.createElement("canvas").getContext("2d");
    if (!ctx || !scratch) return;
    video.style.filter = "blur(18px)";
    return watch({ video, canvas, ctx, scratch, seen: { ready: false } });
  }, [src]);

  return (
    <div className="live-scan">
      <video
        ref={videoRef}
        className="camera-video"
        src={src}
        crossOrigin="anonymous"
        muted
        autoPlay
        loop
        playsInline
        aria-label={`${label} demo feed`}
        onTimeUpdate={onTime ? (event) => onTime(event.currentTarget.currentTime) : undefined}
      />
      <canvas ref={canvasRef} className="live-scan-overlay" aria-hidden="true" />
    </div>
  );
}
