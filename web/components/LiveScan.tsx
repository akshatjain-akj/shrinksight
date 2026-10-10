"use client";

import { useEffect, useRef } from "react";
import { loadCameraConfigs, polygonsForCamera } from "@/lib/cameraConfig";
import { personBox, type Pt } from "@/lib/tier1/geometry";
import { DEFAULT_TUNING, Tier1Engine, type EdgeTuning } from "@/lib/tier1/engine";
import { PersonTracker } from "@/lib/tier1/tracks";
import { privacyBoxes } from "@/lib/tier1/privacy";
import { PoseSmoother } from "@/lib/tier1/oneEuro";
import { loadVision, type VisionModels } from "@/lib/tier1/vision";
import { zonesForReplay } from "@/lib/tier1/zones";
import type { Camera, Rule, Zone, ZoneHint } from "@/lib/types";

const BONES: [number, number][] = [
  [0, 11], [0, 12],
  [11, 13], [13, 15], [12, 14], [14, 16], [11, 12], [23, 24], [11, 23], [12, 24], [23, 25], [24, 26],
];

type Landmark = { x: number; y: number; visibility?: number };
type FaceBox = { originX: number; originY: number; width: number; height: number };

/** Pixelates one face on the overlay canvas, which sits exactly on top of the video. */
function pixelateFace(ctx: CanvasRenderingContext2D, scratch: CanvasRenderingContext2D, video: HTMLVideoElement, face: FaceBox) {
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

let modelsPromise: Promise<VisionModels> | null = null;
// Models are shared by every tile; MediaPipe needs strictly increasing timestamps per model.
let lastStamp = 0;
const nextStamp = () => (lastStamp = Math.max(performance.now(), lastStamp + 1));
let modelUsers = 0;

function acquireModels(): Promise<VisionModels> {
  modelUsers += 1;
  modelsPromise ??= loadVision();
  return modelsPromise;
}

function releaseModels() {
  modelUsers = Math.max(0, modelUsers - 1);
  if (modelUsers > 0 || !modelsPromise) return;
  const closing = modelsPromise;
  modelsPromise = null;
  closing.then((models) => models.close()).catch(() => undefined);
}

function posePeople(poses: Landmark[][], tMs: number) {
  const people = poses.flatMap((pose) => {
    const visible = (i: number): Pt | null => {
      const p = pose[i];
      const min = i === 15 || i === 16 ? 0.35 : 0.5;
      if (!p || (p.visibility ?? 0) < min) return null;
      return { x: p.x, y: p.y };
    };
    const points = pose.filter((p) => (p.visibility ?? 0) >= 0.5).map((p) => ({ x: p.x, y: p.y }));
    const leftHip = visible(23);
    const rightHip = visible(24);
    const shoulder = visible(11) ?? visible(12);
    const hip = leftHip && rightHip
      ? { x: (leftHip.x + rightHip.x) / 2, y: (leftHip.y + rightHip.y) / 2 }
      : leftHip ?? rightHip;
    if (!hip || !shoulder || points.length < 8) return [];
    const box = personBox(points);
    return [{
      hip,
      box,
      sample: {
        tMs,
        present: true,
        leftWrist: visible(15),
        rightWrist: visible(16),
        leftHip,
        rightHip,
        leftShoulder: visible(11),
        rightShoulder: visible(12),
        box,
      },
    }];
  });
  const kept: typeof people = [];
  const ranked = [...people].sort((a, b) => {
    const area = (box: [number, number, number, number] | null) => (box ? Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]) : 0);
    return area(b.box) - area(a.box);
  });
  for (const person of ranked) {
    if (kept.some((other) => Math.hypot(other.hip.x - person.hip.x, other.hip.y - person.hip.y) < 0.22)) continue;
    kept.push(person);
  }
  return kept;
}

/** Plays a stored clip and runs the live edge scan on every frame. */
export interface ScanReading {
  t: number;
  detail: string;
  score: number;
}

export default function LiveScan({
  src,
  camera,
  zones,
  rules,
  controls = false,
  loop = false,
  onScan,
  onTime,
  onAspect,
  onVideo,
  savedZones,
  scoreOnly = false,
  tuning = DEFAULT_TUNING,
}: {
  src: string;
  camera: Camera;
  zones: Zone[];
  rules: Rule[];
  controls?: boolean;
  /** Monitor keeps the aisle playing. Playback scans the clip once. */
  loop?: boolean;
  onScan?: (reading: ScanReading) => void;
  /** The video's current time (seconds), e.g. for demo mode's alert-once. */
  onTime?: (seconds: number) => void;
  /** The clip's width / height once known, so the page can size the player to it. */
  onAspect?: (ratio: number) => void;
  /** The video element, so a page can seek it (e.g. Playback's clickable Gemini timeline). */
  onVideo?: (video: HTMLVideoElement | null) => void;
  /** Zones saved with this incident (marked for this clip); used instead of the camera's layout when present. */
  savedZones?: ZoneHint[] | null;
  /**
   * Playback: Tier-1 only draws (skeleton, zones, score). Its own conclusions never show as text there, because the
   * page shows the stored Gemini result.
   */
  scoreOnly?: boolean;
  /** The camera's auto-tuned gate (live from Firestore). */
  tuning?: EdgeTuning;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const hudRef = useRef<HTMLSpanElement>(null);
  const cameraRef = useRef(camera);
  const zonesRef = useRef(zones);
  const savedZonesRef = useRef(savedZones);
  savedZonesRef.current = savedZones;
  const scoreOnlyRef = useRef(scoreOnly);
  scoreOnlyRef.current = scoreOnly;
  const zonesKey = JSON.stringify(savedZones ?? []);
  const rulesRef = useRef(rules);
  cameraRef.current = camera;
  zonesRef.current = zones;
  rulesRef.current = rules;
  const tuningRef = useRef(tuning);
  const trackerRef = useRef<PersonTracker | null>(null);

  useEffect(() => {
    tuningRef.current = tuning;
    trackerRef.current?.setTuning(tuning);
  }, [tuning]);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const hud = hudRef.current;
    if (!video || !canvas || !hud) return;
    const ctx = canvas.getContext("2d");
    const scratch = document.createElement("canvas").getContext("2d");
    if (!ctx || !scratch) return;
    // Privacy first: the raw picture stays blurred until face detection is running on it.
    video.style.filter = "blur(18px)";
    let faces: FaceBox[] = [];
    let facesReady = false;

    const active = cameraRef.current;
    const shapes = zonesForReplay(
      savedZonesRef.current,
      polygonsForCamera(active.id, zonesRef.current.filter((zone) => active.zone_ids.includes(zone.id))),
    );
    const tracker = new PersonTracker(() => new Tier1Engine(active.kind, shapes, rulesRef.current));
    tracker.setTuning(tuningRef.current);
    trackerRef.current = tracker;
    let models: VisionModels | null = null;
    let alive = true;
    let raf = 0;
    let frame = 0;
    let lastVideoTime = -1;
    let lastPoses: Landmark[][] = [];
    let rawPoses: Landmark[][] = [];
    const smoother = new PoseSmoother();
    let lastDetail = "";
    let lastProcessed = 0;
    let onScreen = true;
    const started = performance.now();
    // Only scan tiles that are on screen; a hidden tab or a scrolled-away tile costs nothing.
    const observer = new IntersectionObserver(([entry]) => {
      onScreen = entry?.isIntersecting ?? true;
    });
    if (canvas.parentElement) observer.observe(canvas.parentElement);
    const PROCESS_EVERY_MS = 66; // ~15 scans per second is plenty for tracking and keeps the page smooth
    acquireModels()
      .then((loaded) => {
        if (!alive) return;
        models = loaded;
      })
      .catch(() => {
        if (hud) hud.textContent = "Scan unavailable";
      });

    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (!alive || !models || video.readyState < 2) return;
      if (video.currentTime + 0.5 < lastVideoTime) lastDetail = "";
      if (video.paused || video.ended || video.currentTime === lastVideoTime) return;
      if (document.hidden || !onScreen) {
        if (facesReady) {
          facesReady = false; // re-check faces before showing the picture again
          video.style.filter = "blur(18px)";
        }
        return;
      }
      const tick = performance.now();
      if (facesReady && tick - lastProcessed < PROCESS_EVERY_MS) return;
      lastProcessed = tick;
      lastVideoTime = video.currentTime;
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!width || !height) return;
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      frame += 1;
      const now = performance.now();
      try {
        if (frame % 2 === 0 || !facesReady) {
          const found = models.pose.detectForVideo(video, nextStamp()).landmarks ?? [];
          rawPoses = found;
          // Smoothed landmarks (One Euro) for the rule engine; privacy blur keeps using the raw, unlagged ones.
          lastPoses = smoother.smooth(found, performance.now()).filter((pose) => posePeople([pose], 0).length > 0);
        }
        if (frame % 3 === 1 || !facesReady) {
          faces = (models.face.detectForVideo(video, nextStamp()).detections ?? []).flatMap((d) =>
            d.boundingBox
              ? [{ originX: d.boundingBox.originX, originY: d.boundingBox.originY, width: d.boundingBox.width, height: d.boundingBox.height }]
              : [],
          );
          if (!facesReady) {
            facesReady = true;
            video.style.filter = "";
          }
        }
      } catch {
        hud.textContent = "Scan blocked";
        video.style.filter = "blur(18px)"; // fail safe: never show unblurred faces
        facesReady = false;
        return;
      }
      tracker.setWatchHealth(loadCameraConfigs()[active.id]?.detection.healthHazard !== false);
      const watched = tracker.update(posePeople(lastPoses, now - started), now - started);
      ctx.clearRect(0, 0, width, height);
      // Faces from the face detector plus heads from the pose model (works at CCTV distance).
      for (const box of privacyBoxes(faces, rawPoses, width, height)) pixelateFace(ctx, scratch, video, box);
      ctx.lineWidth = Math.max(2, width / 320);
      for (const zone of shapes) {
        ctx.strokeStyle = zone.kind === "scanner" ? "#fbbf24" : zone.kind === "bagging" ? "#38bdf8" : "#34d399";
        ctx.beginPath();
        zone.polygon.forEach((point, index) => {
          const x = point.x * width;
          const y = point.y * height;
          if (index === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
        ctx.stroke();
      }
      ctx.strokeStyle = "#e6ebf5";
      for (const pose of lastPoses) {
        const at = (index: number) => {
          const point = pose[index];
          if (!point || (point.visibility ?? 0) < 0.65) return null;
          return point;
        };
        const shoulder = at(11) ?? at(12);
        const hip = at(23) ?? at(24);
        if (!shoulder || !hip || shoulder.y >= hip.y) continue;
        for (const [a, b] of BONES) {
          const pa = at(a);
          const pb = at(b);
          if (!pa || !pb) continue;
          ctx.beginPath();
          ctx.moveTo(pa.x * width, pa.y * height);
          ctx.lineTo(pb.x * width, pb.y * height);
          ctx.stroke();
        }
      }
      ctx.strokeStyle = "#fb923c";
      for (const mark of watched.boxes) {
        const [ymin, xmin, ymax, xmax] = mark.box;
        ctx.strokeRect((xmin / 1000) * width, (ymin / 1000) * height, ((xmax - xmin) / 1000) * width, ((ymax - ymin) / 1000) * height);
      }
      const hit = watched.tick.hits.at(-1);
      if (hit?.detail && hit.detail !== lastDetail) {
        lastDetail = hit.detail;
        onScanRef.current?.({ t: video.currentTime, detail: hit.detail, score: watched.tick.smoothed });
      }
      if (frame % 4 === 0) {
        const score = watched.tick.smoothed.toFixed(2);
        hud.textContent = scoreOnlyRef.current
          ? `Tier-1 on-device · ${lastPoses.length ? `score ${score}` : "waiting for a person"}`
          : hit?.detail || watched.tick.reason || (lastPoses.length ? `Watching · ${score}` : "Waiting for a person");
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      alive = false;
      observer.disconnect();
      cancelAnimationFrame(raf);
      releaseModels();
    };
    // zonesKey: a different saved layout restarts the scan with it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, camera.id, zonesKey]);

  return (
    <div className="live-scan">
      <video
        ref={(element) => {
          videoRef.current = element;
          onVideo?.(element);
        }}
        className="camera-video"
        src={src}
        crossOrigin="anonymous"
        muted
        autoPlay
        playsInline
        loop={loop}
        controls={controls}
        onTimeUpdate={onTime ? (event) => onTime(event.currentTarget.currentTime) : undefined}
        onLoadedMetadata={
          onAspect
            ? (event) => {
                const { videoWidth, videoHeight } = event.currentTarget;
                if (videoWidth && videoHeight) onAspect(videoWidth / videoHeight);
              }
            : undefined
        }
        aria-label={`${camera.name} live scan`}
      />
      <canvas ref={canvasRef} className="live-scan-overlay" />
      <span ref={hudRef} className="live-scan-hud">{scoreOnly ? "Tier-1 on-device · starting" : "Starting scan"}</span>
    </div>
  );
}
