"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";
import type { EdgeConfig } from "@/lib/types";

/** Explains an automatic change to a camera's Tier-1 gate, with Undo. Hidden while the gate is untouched. */
export default function EdgeTuningBanner({ config, cameraName, onChange }: {
  config: EdgeConfig | null;
  cameraName?: string;
  onChange: (config: EdgeConfig) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!config || !config.changed_at) return null;

  const undo = async () => {
    setBusy(true);
    setError(null);
    try {
      onChange(await api.undoEdgeConfig(config.camera_id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const undone = config.reason.startsWith("Undone");
  return (
    <div className="notice tuning-banner" role="status">
      <strong>{undone ? "Gate restored" : "Auto-tuned gate"}{cameraName ? ` · ${cameraName}` : ""}</strong>
      <span className="small">
        {config.reason} Now: score ≥ {config.send_score.toFixed(2)} for {config.hot_frames} frames
        {config.hold_extra_ms ? `, hide hold +${config.hold_extra_ms} ms` : ""} · {dateTime(config.changed_at)}
      </span>
      {!undone && config.level > 0 && (
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={undo}>
          Undo
        </button>
      )}
      {error && <span className="small" style={{ color: "var(--danger)" }}>{error}</span>}
    </div>
  );
}
