"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ApiError, investigateStream } from "@/lib/api";
import { useRules, useStore } from "@/lib/hooks";
import type { Tier1Hit } from "@/lib/tier1/engine.ts";
import { polygonsForCamera } from "@/lib/cameraConfig";
import { personBox, type Pt, type ZoneShape } from "@/lib/tier1/geometry.ts";
import { PersonTracker } from "@/lib/tier1/tracks.ts";
import { Tier1Engine } from "@/lib/tier1/engine.ts";
import { pickFour, type TimedStill } from "@/lib/tier1/stills.ts";
import { loadVision, type VisionModels } from "@/lib/tier1/vision.ts";
import type { Camera } from "@/lib/types";
import { ErrorNotice, Skeletons } from "./ui";

const W = 640;
const H = 360;
const BONES: [number, number][] = [
  [0, 11], [0, 12],
  [11, 13], [13, 15], [12, 14], [14, 16], [11, 12], [23, 24], [11, 23], [12, 24], [23, 25], [24, 26],
];

interface Status {
  models: "loading" | "ready" | "error";
  modelError: string | null;
  smoothed: number;
  hotFrames: number;
  detail: string;
  dwell: Record<string, number>;
  fps: number;
  sent: number;
  sending: boolean;
  paused: string | null;
  incidentId: string | null;
}

const EMPTY: Status = {
  models: "loading",
  modelError: null,
  smoothed: 0,
  hotFrames: 0,
  detail: "Waiting for a person",
  dwell: {},
  fps: 0,
  sent: 0,
  sending: false,
  paused: null,
  incidentId: null,
};

function contain(srcW: number, srcH: number) {
  const scale = Math.min(W / srcW, H / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { scale, ox: (W - w) / 2, oy: (H - h) / 2 };
}

function blurBox(ctx: CanvasRenderingContext2D, scratch: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const sx = Math.max(0, x);
  const sy = Math.max(0, y);
  const sw = Math.min(w, W - sx);
  const sh = Math.min(h, H - sy);
  if (sw < 4 || sh < 4) return;
  const canvas = scratch.canvas;
  canvas.width = Math.max(1, Math.round(sw / 14));
  canvas.height = Math.max(1, Math.round(sh / 14));
  scratch.imageSmoothingEnabled = true;
  scratch.drawImage(ctx.canvas, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(canvas, sx, sy, sw, sh);
}

function strokePersonBox(
  ctx: CanvasRenderingContext2D,
  box: [number, number, number, number],
  fit: { scale: number; ox: number; oy: number },
  srcW: number,
  srcH: number,
) {
  const [ymin, xmin, ymax, xmax] = box;
  const x = fit.ox + (xmin / 1000) * srcW * fit.scale;
  const y = fit.oy + (ymin / 1000) * srcH * fit.scale;
  const w = ((xmax - xmin) / 1000) * srcW * fit.scale;
  const h = ((ymax - ymin) / 1000) * srcH * fit.scale;
  ctx.save();
  ctx.strokeStyle = "#fb923c";
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

type Landmark = { x: number; y: number; visibility?: number };

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
  const ranked = [...people].sort((a, b) => boxArea(b.box) - boxArea(a.box));
  for (const person of ranked) {
    if (kept.some((other) => Math.hypot(other.hip.x - person.hip.x, other.hip.y - person.hip.y) < 0.22)) continue;
    kept.push(person);
  }
  return kept;
}

function boxArea(box: [number, number, number, number] | null): number {
  if (!box) return 0;
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
}

function withCamera(hits: Tier1Hit[], cameraId: string): Tier1Hit[] {
  return hits.map((hit) => ({ ...hit, camera_id: cameraId }));
}

function pickMime(): string {
  const options = ["video/webm;codecs=vp8", "video/webm", "video/mp4"];
  return options.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) ?? "";
}

export default function EdgeConsole() {
  const params = useSearchParams();
  const { store, error: storeError } = useStore();
  const { data: rules } = useRules();
  const [cameraId, setCameraId] = useState(params.get("camera") ?? "cam-sco-1");
  const [consent, setConsent] = useState(false);
  const [fromFile, setFromFile] = useState(false);
  const [checkTill, setCheckTill] = useState(true);
  const [status, setStatus] = useState<Status>(EMPTY);
  const [sourceLabel, setSourceLabel] = useState("No source yet");

  const videoRef = useRef<HTMLVideoElement>(null);
  const blurRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const scratchRef = useRef<CanvasRenderingContext2D | null>(null);
  const modelsRef = useRef<VisionModels | null>(null);
  const trackerRef = useRef<PersonTracker | null>(null);
  const checkTillRef = useRef(true);
  const zonesRef = useRef<ZoneShape[]>([]);
  const headerRef = useRef<Blob | null>(null);
  const clustersRef = useRef<Blob[]>([]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileUrlRef = useRef<string | null>(null);
  const startedRef = useRef(0);
  const sendingRef = useRef(false);
  const consentRef = useRef(false);
  const handedOffRef = useRef(false);
  const holdScoreRef = useRef(false);
  const fromFileRef = useRef(false);
  const pendingRef = useRef<{ hits: Tier1Hit[]; reason: string } | null>(null);
  const stopRef = useRef(false);
  const stillsRef = useRef<TimedStill[]>([]);
  const lastSnapRef = useRef(0);
  const phaseRef = useRef<{ reachAtMs: number | null; holdAtMs: number | null }>({ reachAtMs: null, holdAtMs: null });
  const stillCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const camera = store?.cameras.find((c) => c.id === cameraId) ?? store?.cameras[0];

  useEffect(() => {
    consentRef.current = consent;
  }, [consent]);

  useEffect(() => {
    checkTillRef.current = checkTill;
    trackerRef.current?.setLaneLeave(checkTill && camera?.kind === "checkout");
  }, [checkTill, camera?.kind]);

  useEffect(() => {
    let gone = false;
    loadVision()
      .then((models) => {
        if (gone) models.close();
        else {
          modelsRef.current = models;
          setStatus((s) => ({ ...s, models: "ready", modelError: null }));
        }
      })
      .catch((err: Error) => {
        if (!gone) setStatus((s) => ({ ...s, models: "error", modelError: err.message }));
      });
    scratchRef.current = document.createElement("canvas").getContext("2d");
    const board = document.createElement("canvas");
    board.width = W;
    board.height = H;
    stillCanvasRef.current = board;
    return () => {
      gone = true;
      stopRef.current = true;
      modelsRef.current?.close();
      modelsRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!camera || !store) return;
    const zones = polygonsForCamera(camera.id, store.zones.filter((z) => camera.zone_ids.includes(z.id)));
    zonesRef.current = zones;
    const tracker = new PersonTracker(() => new Tier1Engine(camera.kind, zones, rules ?? []));
    tracker.setLaneLeave(checkTillRef.current && camera.kind === "checkout");
    trackerRef.current = tracker;
  }, [camera, store, rules]);

  useEffect(() => {
    const video = videoRef.current;
    const blur = blurRef.current;
    const overlay = overlayRef.current;
    if (!video || !blur || !overlay) return;
    const btx = blur.getContext("2d");
    const otx = overlay.getContext("2d");
    const scratch = scratchRef.current;
    if (!btx || !otx || !scratch || !camera) return;

    let frame = 0;
    let raf = 0;
    let tail = 0;
    let alive = true;
    let lastTick = performance.now();
    let lastVideoTime = -1;
    let wasPlaying = false;
    let slow = false;
    const fpsMarks: number[] = [];
    let lastPoses: { x: number; y: number; visibility?: number }[][] = [];
    let lastFaces: { originX: number; originY: number; width: number; height: number }[] = [];
    stopRef.current = false;
    startedRef.current = performance.now();
    stillsRef.current = [];
    lastSnapRef.current = 0;

    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (stopRef.current || video.readyState < 2 || !modelsRef.current || !trackerRef.current) return;
      if (video.paused || video.ended || video.currentTime === lastVideoTime) {
        if (wasPlaying && (video.paused || video.ended)) {
          wasPlaying = false;
          setStatus((s) => ({ ...s, fps: 0, detail: video.ended ? "Clip ended" : "Paused" }));
          if (fromFileRef.current && video.ended && !handedOffRef.current && !sendingRef.current) {
            handedOffRef.current = true;
            sendingRef.current = true;
            const payload = { hits: [] as Tier1Hit[], reason: "Uploaded clip finished" };
            pendingRef.current = payload;
            void flush(payload);
          }
        }
        return;
      }
      wasPlaying = true;
      lastVideoTime = video.currentTime;
      const srcW = video.videoWidth || W;
      const srcH = video.videoHeight || H;
      const fit = contain(srcW, srcH);
      frame += 1;
      const now = performance.now();
      slow = now - lastTick > 80;
      lastTick = now;
      try {
        if (frame % (slow ? 4 : 2) === 0) {
          const found = modelsRef.current.pose.detectForVideo(video, now).landmarks ?? [];
          lastPoses = found.filter((pose) => posePeople([pose], 0).length > 0);
        }
        if (frame % 3 === 0) {
          lastFaces = (modelsRef.current.face.detectForVideo(video, now).detections ?? [])
            .map((d) => d.boundingBox)
            .filter((b): b is NonNullable<typeof b> => Boolean(b));
        }
        if (frame % 6 === 0) modelsRef.current.objects.detectForVideo(video, now);
      } catch {
        return;
      }

      btx.fillStyle = "#070d18";
      btx.fillRect(0, 0, W, H);
      btx.drawImage(video, fit.ox, fit.oy, srcW * fit.scale, srcH * fit.scale);
      for (const box of lastFaces) {
        blurBox(
          btx,
          scratch,
          fit.ox + box.originX * fit.scale,
          fit.oy + box.originY * fit.scale,
          box.width * fit.scale,
          box.height * fit.scale,
        );
      }

      const watched = trackerRef.current.update(posePeople(lastPoses, now - startedRef.current), now - startedRef.current);
      const tick = watched.tick;
      phaseRef.current = { reachAtMs: tick.reachAtMs, holdAtMs: tick.holdAtMs };
      for (const mark of watched.boxes) strokePersonBox(btx, mark.box, fit, srcW, srcH);
      if (now - lastSnapRef.current >= 400) {
        lastSnapRef.current = now;
        const board = stillCanvasRef.current;
        const stillCtx = board?.getContext("2d");
        const person = watched.boxes[0]?.box;
        if (board && stillCtx) {
          stillCtx.drawImage(blur, 0, 0, W, H);
          if (person) {
            const [ymin, xmin, ymax, xmax] = person;
            const x = fit.ox + (xmin / 1000) * srcW * fit.scale;
            const y = fit.oy + (ymin / 1000) * srcH * fit.scale;
            const w = ((xmax - xmin) / 1000) * srcW * fit.scale;
            const h = ((ymax - ymin) / 1000) * srcH * fit.scale;
            stillCtx.strokeStyle = "#ef4444";
            stillCtx.lineWidth = 3;
            stillCtx.strokeRect(x, y, w, h);
          }
          const tMs = now - startedRef.current;
          board.toBlob((blob) => {
            if (!blob) return;
            const next = stillsRef.current.filter((shot) => tMs - shot.tMs <= 8000);
            next.push({ tMs, blob });
            stillsRef.current = next;
          }, "image/jpeg", 0.72);
        }
      }

      otx.clearRect(0, 0, W, H);
      otx.lineWidth = 2;
      for (const zone of zonesRef.current) {
        otx.strokeStyle = zone.kind === "scanner" ? "#fbbf24" : zone.kind === "bagging" ? "#38bdf8" : "#34d399";
        otx.beginPath();
        zone.polygon.forEach((p, i) => {
          const x = fit.ox + p.x * srcW * fit.scale;
          const y = fit.oy + p.y * srcH * fit.scale;
          if (i === 0) otx.moveTo(x, y);
          else otx.lineTo(x, y);
        });
        otx.closePath();
        otx.stroke();
      }
      otx.strokeStyle = "#e6ebf5";
      for (const pose of lastPoses) {
        const at = (i: number) => {
          const p = pose[i];
          if (!p || (p.visibility ?? 0) < 0.65) return null;
          return { x: p.x, y: p.y };
        };
        const shoulder = at(11) ?? at(12);
        const hip = at(23) ?? at(24);
        if (!shoulder || !hip || shoulder.y >= hip.y) continue;
        for (const [a, b] of BONES) {
          const pa = at(a);
          const pb = at(b);
          if (!pa || !pb) continue;
          otx.beginPath();
          otx.moveTo(fit.ox + pa.x * srcW * fit.scale, fit.oy + pa.y * srcH * fit.scale);
          otx.lineTo(fit.ox + pb.x * srcW * fit.scale, fit.oy + pb.y * srcH * fit.scale);
          otx.stroke();
        }
      }
      for (const mark of watched.boxes) strokePersonBox(otx, mark.box, fit, srcW, srcH);

      fpsMarks.push(now);
      while (fpsMarks.length && fpsMarks[0] < now - 1000) fpsMarks.shift();
      const liveGate = !fromFileRef.current && tick.shouldSend;
      if (liveGate) {
        setStatus((s) => ({
          ...s,
          smoothed: tick.smoothed,
          hotFrames: tick.hotFrames,
          dwell: tick.dwellSeconds,
          fps: fpsMarks.length,
          detail: tick.reason,
        }));
        holdScoreRef.current = true;
      } else if (!holdScoreRef.current && frame % 8 === 0) {
        setStatus((s) => ({
          ...s,
          smoothed: tick.smoothed,
          hotFrames: tick.hotFrames,
          dwell: tick.dwellSeconds,
          fps: fpsMarks.length,
          detail: tick.reason || (tick.smoothed >= 0.4 ? "Score is high" : lastPoses.length ? "Watching" : "Waiting for a person"),
        }));
      } else if (frame % 8 === 0) {
        setStatus((s) => ({ ...s, fps: fpsMarks.length }));
      }

      if (liveGate && !sendingRef.current) {
        sendingRef.current = true;
        trackerRef.current.noteSent(now - startedRef.current, watched.activeId);
        const payload = { hits: withCamera(tick.hits, camera.id), reason: tick.reason };
        tail = window.setTimeout(() => {
          if (!alive) return;
          pendingRef.current = payload;
          void flush(payload);
        }, 3000);
      }
    };

    const flush = async (payload: { hits: Tier1Hit[]; reason: string }) => {
      if (!alive) return;
      handedOffRef.current = true;
      if (!consentRef.current) {
        sendingRef.current = false;
        const paused = fromFileRef.current
          ? "Tick consent, then Gemini reviews this file."
          : "Tier 1 wants a Gemini review. Tick consent, then send.";
        setStatus((s) => ({ ...s, paused, detail: payload.reason }));
        return;
      }
      setStatus((s) => ({ ...s, sending: true, paused: null, detail: "Recording a blurred clip for Gemini…" }));
      const blob = await captureClip();
      if (!blob || !camera) {
        sendingRef.current = false;
        setStatus((s) => ({ ...s, sending: false, paused: "The blurred clip was too short to send. Let the video play, then send again." }));
        return;
      }
      setStatus((s) => ({ ...s, sending: true, paused: null, detail: payload.reason || "Gemini is reviewing the blurred clip" }));
      try {
        await investigateStream(
          blob,
          { camera_id: camera.id, tier1_events: payload.hits },
          (event) => {
            if (event.type === "result") {
              holdScoreRef.current = false;
              setStatus((s) => ({
                ...s,
                sending: false,
                sent: s.sent + 1,
                incidentId: event.incident.id,
                detail: event.cached ? "Cached analysis" : "Gemini filed an incident",
              }));
            } else if (event.type === "error") {
              holdScoreRef.current = false;
              setStatus((s) => ({ ...s, sending: false, paused: event.message }));
            }
          },
          undefined,
          pickFour(stillsRef.current, phaseRef.current.reachAtMs, phaseRef.current.holdAtMs),
        );
      } catch (err) {
        const paused = err instanceof ApiError && err.status === 429
          ? "AI review paused. Today's free quota is used up. Tier 1 is still watching."
          : (err as Error).message;
        holdScoreRef.current = false;
        setStatus((s) => ({ ...s, sending: false, paused }));
      } finally {
        sendingRef.current = false;
      }
    };

    raf = requestAnimationFrame(loop);
    return () => {
      alive = false;
      stopRef.current = true;
      clearTimeout(tail);
      cancelAnimationFrame(raf);
    };
  }, [camera, status.models]);

  const startRecorder = (canvas: HTMLCanvasElement) => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
    headerRef.current = null;
    clustersRef.current = [];
    const stream = canvas.captureStream(8);
    const mime = pickMime();
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 350_000 } : undefined);
    recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      // The first chunk holds the WebM header. Later chunks are clusters and can rotate.
      if (!headerRef.current) headerRef.current = event.data;
      else {
        clustersRef.current.push(event.data);
        if (clustersRef.current.length > 8) clustersRef.current.shift();
      }
    };
    recorder.start(1000);
    recorderRef.current = recorder;
  };

  const blobFromParts = (mime: string) => {
    const header = headerRef.current;
    const parts = header ? [header, ...clustersRef.current] : clustersRef.current;
    return new Blob(parts, { type: mime });
  };

  const isVideoBlob = async (blob: Blob) => {
    if (blob.size < 4_000) return false;
    const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const webm = bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
    const mp4 = bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
    return webm || mp4;
  };

  const stopRecorder = (recorder: MediaRecorder) => new Promise<Blob>((resolve) => {
    const mime = recorder.mimeType || "video/webm";
    recorder.addEventListener("stop", () => resolve(blobFromParts(mime)), { once: true });
    if (recorder.state === "recording") recorder.stop();
    else resolve(new Blob([], { type: mime }));
  });

  /** Plays the source long enough to write one complete blurred file for Gemini. */
  const captureClip = async (): Promise<Blob | null> => {
    const canvas = blurRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return null;
    if (video.ended && Number.isFinite(video.duration) && video.duration > 1) {
      video.currentTime = Math.max(0, video.duration - 5);
    }
    await video.play().catch(() => undefined);

    const rolling = recorderRef.current;
    if (rolling?.state === "recording") {
      const blob = await stopRecorder(rolling);
      if (await isVideoBlob(blob)) {
        startRecorder(canvas);
        return blob;
      }
    }

    headerRef.current = null;
    clustersRef.current = [];
    const mime = pickMime();
    const recorder = new MediaRecorder(canvas.captureStream(8), mime ? { mimeType: mime, videoBitsPerSecond: 350_000 } : undefined);
    recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      if (!headerRef.current) headerRef.current = event.data;
      else clustersRef.current.push(event.data);
    };
    const fresh = new Promise<Blob>((resolve) => {
      recorder.addEventListener("stop", () => resolve(blobFromParts(recorder.mimeType || mime || "video/webm")), { once: true });
      recorder.start(250);
      window.setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, 4000);
    });
    recorderRef.current = recorder;
    const blob = await fresh;
    startRecorder(canvas);
    return (await isVideoBlob(blob)) ? blob : null;
  };

  const stopInputs = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (fileUrlRef.current) URL.revokeObjectURL(fileUrlRef.current);
    fileUrlRef.current = null;
    recorderRef.current?.stop();
    recorderRef.current = null;
  };

  useEffect(() => () => stopInputs(), []);

  const attachVideo = (src: string | MediaStream, label: string) => {
    const video = videoRef.current;
    const blur = blurRef.current;
    if (!video || !blur) return;
    stopInputs();
    if (typeof src === "string") {
      fileUrlRef.current = src;
      video.srcObject = null;
      video.src = src;
    } else {
      streamRef.current = src;
      video.srcObject = src;
    }
    startedRef.current = performance.now();
    stillsRef.current = [];
    lastSnapRef.current = 0;
    phaseRef.current = { reachAtMs: null, holdAtMs: null };
    handedOffRef.current = false;
    holdScoreRef.current = false;
    setSourceLabel(label);
    setStatus((s) => ({ ...EMPTY, models: s.models, modelError: s.modelError }));
    video.onloadeddata = () => startRecorder(blur);
    void video.play().catch(() => undefined);
  };

  const useWebcam = async () => {
    fromFileRef.current = false;
    setFromFile(false);
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 360 }, audio: false });
    attachVideo(stream, "Webcam");
  };

  const useFile = (file: File) => {
    fromFileRef.current = true;
    setFromFile(true);
    setCameraId("cam-aisle-4");
    attachVideo(URL.createObjectURL(file), file.name);
  };

  const sendHeld = async () => {
    const payload = pendingRef.current;
    if (!payload) return;
    setConsent(true);
    consentRef.current = true;
    handedOffRef.current = true;
    sendingRef.current = true;
    setStatus((s) => ({ ...s, sending: true, paused: null, detail: "Recording a blurred clip for Gemini…" }));
    const blob = await captureClip();
    if (!blob) {
      setStatus((s) => ({ ...s, sending: false, paused: "The blurred clip was too short to send. Let the video play, then send again." }));
      sendingRef.current = false;
      return;
    }
    setStatus((s) => ({ ...s, detail: "Gemini is reviewing the blurred clip" }));
    void investigateStream(
      blob,
      { camera_id: camera?.id ?? cameraId, tier1_events: payload.hits },
      (event) => {
        if (event.type === "result") {
          holdScoreRef.current = false;
          setStatus((s) => ({ ...s, sending: false, sent: s.sent + 1, incidentId: event.incident.id, paused: null, detail: "Gemini filed an incident" }));
        } else if (event.type === "error") {
          holdScoreRef.current = false;
          setStatus((s) => ({ ...s, sending: false, paused: event.message }));
        }
      },
      undefined,
      pickFour(stillsRef.current, phaseRef.current.reachAtMs, phaseRef.current.holdAtMs),
    ).catch((err: Error) => {
      holdScoreRef.current = false;
      setStatus((s) => ({ ...s, sending: false, paused: err.message }));
    })
      .finally(() => {
        sendingRef.current = false;
      });
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Live edge</h1>
          <p>MediaPipe watches every frame on this device. Faces are blurred before anything is recorded. Gemini runs only when the gate opens.</p>
        </div>
      </div>
      {storeError && <ErrorNotice>Couldn’t load the store: {storeError}</ErrorNotice>}
      {!store && !storeError && <Skeletons count={2} />}
      {store && camera && (
        <div className="grid-main">
          <div className="stack">
            <div className="edge-stage">
              <video ref={videoRef} className="edge-video" playsInline muted />
              <canvas ref={blurRef} className="edge-blur" width={W} height={H} aria-label="Face-blurred camera" />
              <canvas ref={overlayRef} className="edge-overlay" width={W} height={H} />
            </div>
            <div className="row">
              <button type="button" className="btn btn-primary" onClick={() => void useWebcam().catch((e: Error) => setStatus((s) => ({ ...s, paused: e.message })))}>
                Use webcam
              </button>
              <label className="btn">
                Play a video file
                <input className="visually-hidden" type="file" accept="video/*" onChange={(e) => e.target.files?.[0] && useFile(e.target.files[0])} />
              </label>
              <span className="muted small">{sourceLabel}</span>
            </div>
            {status.models === "loading" && <p className="muted">Loading MediaPipe models…</p>}
            {status.models === "error" && <ErrorNotice>{status.modelError ?? "MediaPipe failed to load."}</ErrorNotice>}
          </div>
          <aside className="card stack">
            <label className="field">
              Camera
              <select value={camera.id} onChange={(e) => setCameraId(e.target.value)}>
                {store.cameras.map((c: Camera) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
            <p className="edge-score" aria-live="polite">
              Score <strong>{status.smoothed.toFixed(2)}</strong>
              <span className="muted small"> · {status.hotFrames}/8 hot frames · {status.detail}</span>
            </p>
            <div className="row">
              <span className="chip">{status.fps} fps</span>
              <span className="chip tone-success">{status.sent} sent</span>
            </div>
            {Object.entries(status.dwell).map(([id, sec]) => (
              <span key={id} className="muted small">{id}: {sec.toFixed(1)}s in zone</span>
            ))}
            {camera.kind === "checkout" && !fromFile && (
              <label className="row" style={{ fontWeight: 400 }}>
                <input type="checkbox" checked={checkTill} onChange={(e) => setCheckTill(e.target.checked)} />
                <span className="small">After a real signal, send the session to Gemini when the shopper leaves the lane</span>
              </label>
            )}
            <label className="row" style={{ alignItems: "flex-start", fontWeight: 400 }}>
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 4 }} />
              <span className="small">Everyone in frame agreed to be recorded. Only the blurred clip is analysed. The raw camera never leaves this device.</span>
            </label>
            {status.paused && <ErrorNotice>{status.paused}</ErrorNotice>}
            {status.paused?.includes("consent") && (
              <button type="button" className="btn btn-primary" onClick={sendHeld}>Send blurred clip</button>
            )}
            {status.sending && <p className="muted">{fromFile ? "Gemini is reviewing the uploaded clip…" : "Gemini is investigating the gated clip…"}</p>}
            {status.incidentId && (
              <Link href={`/incident?id=${status.incidentId}`} className="btn btn-primary">Open the incident</Link>
            )}
            <p className="hint" style={{ margin: 0 }}>
              {fromFile
                ? "Uploaded files skip the live gate. Gemini reviews the blurred clip when playback ends."
                : "The live camera sends a clip only when the gate opens. Yellow is the scanner, blue is bagging, green is the shelf or exit."}
            </p>
          </aside>
        </div>
      )}
    </>
  );
}
