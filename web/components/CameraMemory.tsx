"use client";

import { useEffect, useState } from "react";
import { ErrorNotice } from "@/components/ui";
import { api } from "@/lib/api";

/** Settings → Cameras: how many past review decisions Gemini sees for this camera, and a way to forget them. */
export default function CameraMemory({ cameraId }: { cameraId: string }) {
  const [info, setInfo] = useState<{ decisions: number; used_per_clip: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cleared, setCleared] = useState<number | null>(null);

  useEffect(() => {
    let cancel = false;
    setInfo(null);
    setCleared(null);
    setError(null);
    api
      .cameraMemory(cameraId)
      .then((res) => !cancel && setInfo(res))
      .catch(() => !cancel && setInfo(null));
    return () => {
      cancel = true;
    };
  }, [cameraId]);

  const clear = async () => {
    if (!window.confirm("Forget every past review decision for this camera? Incidents and their reviews stay.")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.clearCameraMemory(cameraId);
      setCleared(res.cleared);
      setInfo({ decisions: 0, used_per_clip: 0 });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ gap: "0.4rem" }}>
      <strong className="small">Camera memory</strong>
      <span className="hint">
        {info == null
          ? "Past review decisions Gemini sees on this camera."
          : info.decisions === 0
            ? "No past review decisions. Gemini judges each clip on its own."
            : `${info.decisions} past review decision${info.decisions === 1 ? "" : "s"}; the newest ${info.used_per_clip} go into every investigation on this camera.`}
      </span>
      <button type="button" className="btn btn-sm" disabled={busy || info?.decisions === 0} onClick={clear}>
        Clear this camera’s memory
      </button>
      {cleared != null && <span className="hint">Forgot {cleared} decision{cleared === 1 ? "" : "s"}.</span>}
      {error && <ErrorNotice>{error}</ErrorNotice>}
    </div>
  );
}
