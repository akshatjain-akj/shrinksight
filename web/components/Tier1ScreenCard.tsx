"use client";

import type { EdgeTuning } from "@/lib/tier1/engine.ts";
import type { ScanResult } from "@/lib/tier1/scanClip";

const KIND_TEXT: Record<string, string> = {
  CONCEALMENT: "possible hide",
  SHELF_REACH: "shelf reach",
  SCANNER_BYPASS: "item skipped the scanner",
  PUT_BACK: "put back",
  HEALTH_HAZARD: "person down",
  DWELL: "long stay in a zone",
  ZONE_ENTRY: "entered a zone",
  LANE_CLEAR: "left the lane",
};

export function hitText(hit: { kind: string; t: string }): string {
  return `${KIND_TEXT[hit.kind] ?? hit.kind.toLowerCase()} at ${hit.t}`;
}

/** Investigate: Tier-1 cleared the clip, so Gemini was not called. Says what it saw and offers an override. */
export default function Tier1ScreenCard({
  result,
  gate,
  canSend,
  onSendAnyway,
}: {
  result: ScanResult;
  gate: EdgeTuning;
  canSend: boolean;
  onSendAnyway: () => void;
}) {
  const seen = Math.round(result.personSeen * 100);
  return (
    <div className="screen-card stack" role="status">
      <strong>Tier-1 cleared this clip · 0 Gemini tokens used</strong>
      <span className="small">
        The on-device check saw nothing that opens this camera’s gate (highest score {result.peakScore.toFixed(2)}; the
        gate needs {gate.sendScore.toFixed(2)} for {gate.hotFrames} frames in a row).
      </span>
      <ul className="small screen-seen">
        <li>{seen > 0 ? `A person was in view for ${seen}% of the ${result.seconds.toFixed(1)} s clip` : "No person was detected in the clip"}</li>
        {result.hits.length > 0 ? (
          <li>Weaker signals: {result.hits.map(hitText).join(", ")}</li>
        ) : (
          seen > 0 && <li>No reach, hide or zone signal</li>
        )}
      </ul>
      <button type="button" className="btn" disabled={!canSend} onClick={onSendAnyway}>
        Send to Gemini anyway
      </button>
      <span className="hint">If Tier-1 missed something, Gemini checks the whole clip with these signals as hints.</span>
    </div>
  );
}
