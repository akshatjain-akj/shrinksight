"use client";

import { useEffect, useRef } from "react";
import { loadCameraConfigs, polygonsForCamera } from "@/lib/cameraConfig";
import { personBox, type Pt } from "@/lib/tier1/geometry";
import { Tier1Engine } from "@/lib/tier1/engine";
import { PersonTracker } from "@/lib/tier1/tracks";
import { loadVision, type VisionModels } from "@/lib/tier1/vision";
import type { Camera, Rule, Zone } from "@/lib/types";

const BONES: [number, number][] = [
  [0, 11], [0, 12],
  [11, 13], [13, 15], [12, 14], [14, 16], [11, 12], [23, 24], [11, 23], [12, 24], [23, 25], [24, 26],
];

type Landmark = { x: number; y: number; visibility?: number };

let modelsPromise: Promise<VisionModels> | null = null;
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
}: {
  src: string;
  camera: Camera;
  zones: Zone[];
  rules: Rule[];
  controls?: boolean;
  /** Monitor keeps the aisle playing. Playback scans the clip once. */
  loop?: boolean;
  onScan?: (reading: ScanReading) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const hudRef = useRef<HTMLSpanElement>(null);
  const cameraRef = useRef(camera);
  const zonesRef = useRef(zones);
  const rulesRef = useRef(rules);
  cameraRef.current = camera;
  zonesRef.current = zones;
  rulesRef.current = rules;

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const hud = hudRef.current;
    if (!video || !canvas || !hud) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const active = cameraRef.current;
    const shapes = polygonsForCamera(active.id, zonesRef.current.filter((zone) => active.zone_ids.includes(zone.id)));
    const tracker = new PersonTracker(() => new Tier1Engine(active.kind, shapes, rulesRef.current));
    let models: VisionModels | null = null;
    let alive = true;
    let raf = 0;
    let frame = 0;
    let lastVideoTime = -1;
    let lastPoses: Landmark[][] = [];
    let lastDetail = "";
    const started = performance.now();
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
      lastVideoTime = video.currentTime;
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!width || !height) return;
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      frame += 1;
      const now = performance.now();
      try {
        if (frame % 2 === 0) {
          const found = models.pose.detectForVideo(video, now).landmarks ?? [];
          lastPoses = found.filter((pose) => posePeople([pose], 0).length > 0);
        }
      } catch {
        hud.textContent = "Scan blocked";
        return;
      }
      tracker.setWatchHealth(loadCameraConfigs()[active.id]?.detection.healthHazard !== false);
      const watched = tracker.update(posePeople(lastPoses, now - started), now - started);
      ctx.clearRect(0, 0, width, height);
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
        hud.textContent = hit?.detail || watched.tick.reason || (lastPoses.length ? `Watching · ${score}` : "Waiting for a person");
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      releaseModels();
    };
  }, [src, camera.id]);

  return (
    <div className="live-scan">
      <video
        ref={videoRef}
        className="camera-video"
        src={src}
        crossOrigin="anonymous"
        muted
        autoPlay
        playsInline
        loop={loop}
        controls={controls}
        aria-label={`${camera.name} live scan`}
      />
      <canvas ref={canvasRef} className="live-scan-overlay" />
      <span ref={hudRef} className="live-scan-hud">Starting scan</span>
    </div>
  );
}
