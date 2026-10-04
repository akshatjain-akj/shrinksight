"use client";

import { useEffect, useRef, useState } from "react";
import { ErrorNotice } from "./ui";

const RECORD_SECONDS = 10;
const MIME_PREFERENCE = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];

type Phase = "idle" | "preview" | "countdown" | "recording";

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return MIME_PREFERENCE.find((m) => MediaRecorder.isTypeSupported(m));
}

/** Records a short clip from the webcam using the browser's built-in MediaRecorder (no uploads until you choose). */
export default function ClipRecorder({ onClip }: { onClip: (clip: Blob) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [count, setCount] = useState(3);
  const [error, setError] = useState<string | null>(null);

  const stopStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  useEffect(() => stopStream, []);

  const startCamera = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setPhase("preview");
    } catch {
      setError("Camera access was blocked or no camera was found. Allow camera access and try again.");
    }
  };

  const record = async () => {
    const stream = streamRef.current;
    const mimeType = pickMime();
    if (!stream || !mimeType) {
      setError("This browser can't record video. Try Chrome, Edge or Safari, or upload a file instead.");
      return;
    }
    setPhase("countdown");
    for (let i = 3; i > 0; i--) {
      setCount(i);
      await new Promise((r) => setTimeout(r, 1000));
    }
    const chunks: BlobPart[] = [];
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1_500_000 });
    recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    recorder.onstop = () => {
      stopStream();
      setPhase("idle");
      onClip(new Blob(chunks, { type: mimeType.split(";")[0] }));
    };
    setPhase("recording");
    recorder.start();
    setTimeout(() => recorder.state === "recording" && recorder.stop(), RECORD_SECONDS * 1000);
  };

  return (
    <div className="stack">
      <div className="evidence" style={{ aspectRatio: "16 / 9", display: phase === "idle" ? "none" : "block" }}>
        <video ref={videoRef} autoPlay muted playsInline aria-label="Webcam preview" />
        {phase === "countdown" && (
          <div className="countdown" aria-live="assertive">
            {count}
          </div>
        )}
        {phase === "recording" && (
          <div className="camera-label" style={{ position: "absolute" }}>
            <span className="rec-dot" aria-hidden="true" />
            <span className="chip tone-danger">Recording {RECORD_SECONDS} s…</span>
          </div>
        )}
      </div>
      <div className="row">
        {phase === "idle" && (
          <button type="button" className="btn" onClick={startCamera}>
            Turn on camera
          </button>
        )}
        {phase === "preview" && (
          <>
            <button type="button" className="btn btn-primary" onClick={record}>
              ● Record {RECORD_SECONDS} seconds
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                stopStream();
                setPhase("idle");
              }}
            >
              Cancel
            </button>
          </>
        )}
      </div>
      <p className="hint" style={{ margin: 0 }}>
        Tip: point the camera down at a table, mark a “scanner” square, and move items past it, skipping one.
      </p>
      {error && <ErrorNotice>{error}</ErrorNotice>}
    </div>
  );
}
