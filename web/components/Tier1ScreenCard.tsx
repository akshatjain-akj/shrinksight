"use client";

import type { EdgeTuning } from "@/lib/tier1/engine.ts";
import { stamp } from "@/lib/tier1/engine.ts";
import type { ScanResult } from "@/lib/tier1/scanClip";
import type { BodySpot } from "@/lib/types";

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

const SPOT_TEXT: Record<BodySpot, string> = {
  pocket: "at pocket height",
  bag: "out at the side (bag height)",
  shirt: "at the centre of the torso",
  waistband: "at the waistband",
};

export function hitText(hit: { kind: string; t: string }): string {
  return `${KIND_TEXT[hit.kind] ?? hit.kind.toLowerCase()} at ${hit.t}`;
}

const at = (seconds: number) => stamp(seconds * 1000);

/**
 * Investigate: what Tier-1 decided and measured on this device. Nothing has gone to Gemini yet; staff choose whether
 * to send the clip with the measurements, or without them (to compare).
 */
export default function Tier1ScreenCard({
  result,
  gate,
  receiptLines,
  canSend,
  onSend,
}: {
  result: ScanResult;
  gate: EdgeTuning;
  /** Lines on the chosen receipt (checkout), to compare with the trip count. */
  receiptLines: number | null;
  canSend: boolean;
  onSend: (withMeasurements: boolean) => void;
}) {
  const seen = Math.round(result.personSeen * 100);
  const { shelf_contacts: contacts, holds, trips } = result.measured;
  const scannedTrips = trips?.filter((trip) => trip.via_scanner).length ?? 0;
  const tooManyTrips = trips != null && receiptLines != null && trips.length > receiptLines;
  return (
    <div className="screen-card stack" role="status">
      <strong>
        {result.flagged ? "Tier-1 would send this clip to Gemini" : "Tier-1 would not send this clip"} · 0 Gemini tokens
        used
      </strong>
      <span className="small">
        {result.flagged
          ? `The gate opened at ${stamp(result.openedAtMs ?? 0)}${result.reason ? ` (${result.reason.toLowerCase()})` : ""}.`
          : `Highest score ${result.peakScore.toFixed(2)}; the gate needs ${gate.sendScore.toFixed(2)} for ${gate.hotFrames} frames in a row.`}
      </span>
      <ul className="small screen-seen">
        <li>{seen > 0 ? `A person was in view for ${seen}% of the ${result.seconds.toFixed(1)} s clip` : "No person was detected in the clip"}</li>
        {result.hits.length > 0 && <li>Gate signals: {result.hits.map(hitText).join(", ")}</li>}
      </ul>

      <strong className="small">Measured (sent to Gemini only as moments to look at)</strong>
      <ul className="small screen-seen">
        {trips != null && (
          <li>
            {trips.length} trip{trips.length === 1 ? "" : "s"} from the item pile to the bagging area, {scannedTrips} through
            the scanner zone
            {receiptLines != null && (
              <>
                {" "}
                · receipt has {receiptLines} line{receiptLines === 1 ? "" : "s"}
                {tooManyTrips && <strong> · more trips than receipt lines</strong>}
              </>
            )}
            {trips.length > 0 && (
              <ul>
                {trips.map((trip, i) => (
                  <li key={i}>
                    Trip {i + 1}: {at(trip.start_s)} → {at(trip.end_s)}
                    {trip.via_scanner ? "" : <strong> · not through the scanner zone</strong>}
                  </li>
                ))}
              </ul>
            )}
          </li>
        )}
        {contacts.map((contact, i) => (
          <li key={`c${i}`}>
            {contact.hand === "left" ? "Left" : "Right"} hand on the shelf {at(contact.start_s)}–{at(contact.end_s)}
          </li>
        ))}
        {holds.map((hold, i) => (
          <li key={`h${i}`}>
            Then rested {SPOT_TEXT[hold.spot]} {at(hold.start_s)}–{at(hold.end_s)} ({(hold.end_s - hold.start_s).toFixed(1)} s)
          </li>
        ))}
        {trips == null && contacts.length === 0 && holds.length === 0 && <li>No shelf contact or hand rest measured</li>}
        {result.closeUps.length > 0 && (
          <li>
            {result.closeUps.length} hand close-up{result.closeUps.length === 1 ? "" : "s"} at these moments
          </li>
        )}
      </ul>

      <div className="row">
        <button type="button" className="btn btn-primary" disabled={!canSend} onClick={() => onSend(true)}>
          Send to Gemini with measurements
        </button>
        <button type="button" className="btn" disabled={!canSend} onClick={() => onSend(false)}>
          Send without them
        </button>
      </div>
      <span className="hint">
        Tier-1 never decides here. If Gemini finds nothing but the measurements disagree (more trips than receipt lines,
        or a hand resting on the body right after the shelf), the incident goes to Needs review.
      </span>
    </div>
  );
}
