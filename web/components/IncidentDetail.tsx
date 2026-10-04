"use client";

import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { clipSeconds, dateTime, inr } from "@/lib/format";
import type { Incident, SeenItem } from "@/lib/types";
import { ErrorNotice, StatusPill, VerdictBadge } from "./ui";

const TOOL_TEXT: Record<string, (args: Record<string, unknown>) => string> = {
  get_pos_transaction: (a) => `Checked the till receipt${a.lane_id ? ` (lane ${a.lane_id})` : ""}`,
  get_zone_policy: (a) => `Checked the zone policy${a.zone_id ? ` (${a.zone_id})` : ""}`,
  get_sku_price: (a) => `Looked up the price of “${String(a.description ?? "item")}”`,
};

function AgentSteps({ incident }: { incident: Incident }) {
  const steps = [
    "Watched the clip",
    ...incident.tool_calls.map((c) => (TOOL_TEXT[c.name] ?? (() => c.name))(c.args)),
    "Wrote the incident report",
  ];
  return (
    <ul className="steps" aria-label="What the Gemini agent did">
      {steps.map((step, i) => (
        <li key={i} className="done">
          <span className="tick" aria-hidden="true">
            ✓
          </span>
          {step}
        </li>
      ))}
    </ul>
  );
}

function Evidence({ incident, videoUrl, focus, videoRef }: {
  incident: Incident;
  videoUrl?: string;
  focus: SeenItem | null;
  videoRef: React.RefObject<HTMLVideoElement | null>;
}) {
  const [aspect, setAspect] = useState(16 / 9);
  const box = focus?.box_2d?.length === 4 ? focus.box_2d : null;
  const note = videoUrl
    ? null
    : incident.source === "seed"
      ? "Example incident · footage for the demo store is coming soon"
      : "Clips aren’t stored. ShrinkSight analyses them and keeps only the report (privacy by design).";

  return (
    <div className={`evidence${videoUrl ? "" : " evidence-placeholder"}`} style={videoUrl ? { aspectRatio: aspect } : undefined}>
      {videoUrl && (
        <video
          ref={videoRef}
          src={videoUrl}
          controls
          playsInline
          muted
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight);
          }}
        />
      )}
      {box && (
        <div
          className="bbox"
          style={{
            top: `${box[0] / 10}%`,
            left: `${box[1] / 10}%`,
            height: `${(box[2] - box[0]) / 10}%`,
            width: `${(box[3] - box[1]) / 10}%`,
          }}
        >
          <span>
            {focus!.description} · {focus!.t}
          </span>
        </div>
      )}
      {note && <p className="evidence-note">{note}</p>}
    </div>
  );
}

export default function IncidentDetail({ incident, videoUrl }: { incident: Incident; videoUrl?: string }) {
  const { verdict } = incident;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [focus, setFocus] = useState<SeenItem | null>(
    () => verdict.seen_items.find((s) => !s.scanned && s.box_2d.length === 4) ?? null,
  );
  const [current, setCurrent] = useState(incident);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seek = (t: string, item?: SeenItem) => {
    if (item) setFocus(item);
    if (videoRef.current) {
      videoRef.current.currentTime = clipSeconds(t);
      videoRef.current.pause();
    }
  };

  const review = async (decision: "confirm" | "dismiss") => {
    setReviewing(true);
    setError(null);
    try {
      setCurrent(await api.review(incident.id, decision));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReviewing(false);
    }
  };

  const isCheckout = incident.camera_kind === "checkout";
  const receiptTotal = incident.receipt.reduce((sum, line) => sum + line.price_inr, 0);

  return (
    <article className="stack" aria-labelledby="incident-title">
      <div className="card">
        <div className="detail-head">
          <div>
            <p className="muted small" style={{ margin: 0 }}>
              {incident.camera_name} · {dateTime(incident.created_at)}
            </p>
            <h1 id="incident-title" style={{ margin: "0.2rem 0 0.4rem" }}>
              {incident.camera_kind === "checkout" ? "Self-checkout investigation" : "Shop-floor investigation"}
            </h1>
            <div className="row">
              <VerdictBadge verdict={verdict.verdict} confidence={verdict.confidence} />
              <StatusPill status={current.status} />
              {incident.source === "seed" && <span className="chip">Example</span>}
            </div>
          </div>
          {incident.est_loss_inr > 0 && (
            <div style={{ textAlign: "right" }}>
              <div className="muted small">Estimated loss</div>
              <div className="loss">{inr(incident.est_loss_inr)}</div>
            </div>
          )}
        </div>
        <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "0.9rem 0" }} />
        <AgentSteps incident={incident} />
      </div>

      <div className="grid-main">
        <div className="card stack">
          <h2>Evidence</h2>
          <Evidence incident={incident} videoUrl={videoUrl} focus={focus} videoRef={videoRef} />
          <blockquote className="reason">{verdict.reason}</blockquote>
          {verdict.timeline.length > 0 && (
            <section>
              <h3>What happened</h3>
              <ol className="timeline">
                {verdict.timeline.map((ev, i) => (
                  <li key={i}>
                    <button type="button" className="linkish time" onClick={() => seek(ev.t)}>
                      {ev.t}
                    </button>
                    <span>{ev.event}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>

        <div className="stack">
          {isCheckout && (
            <section className="card" aria-labelledby="compare-title">
              <h2 id="compare-title">Seen on camera vs. till receipt</h2>
              <p className="muted small" style={{ marginTop: 0 }}>
                {verdict.items_seen} handled · {verdict.items_scanned} scanned · {incident.receipt.length} on receipt
              </p>
              <table className="compare">
                <thead>
                  <tr>
                    <th scope="col">Seen on camera</th>
                    <th scope="col">Scanned?</th>
                  </tr>
                </thead>
                <tbody>
                  {verdict.seen_items.map((item, i) => (
                    <tr key={i} className={item.scanned ? undefined : "missing"}>
                      <td>
                        <button type="button" className="linkish" onClick={() => seek(item.t, item)}>
                          {item.description}
                        </button>{" "}
                        <span className="time">{item.t}</span>
                      </td>
                      <td>{item.scanned ? "✓ Yes" : <strong style={{ color: "var(--danger)" }}>✗ No</strong>}</td>
                    </tr>
                  ))}
                  {verdict.seen_items.length === 0 && (
                    <tr>
                      <td colSpan={2} className="muted">
                        No items listed
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              <table className="compare" style={{ marginTop: "1rem" }}>
                <thead>
                  <tr>
                    <th scope="col">Till receipt{incident.transaction_id ? ` · ${incident.transaction_id}` : ""}</th>
                    <th scope="col" className="num">
                      Price
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {incident.receipt.map((line, i) => (
                    <tr key={i}>
                      <td>{line.name}</td>
                      <td className="num">{inr(line.price_inr)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td>
                      <strong>Total paid</strong>
                    </td>
                    <td className="num">
                      <strong>{inr(receiptTotal)}</strong>
                    </td>
                  </tr>
                </tbody>
              </table>
            </section>
          )}

          {incident.unscanned_items.length > 0 && (
            <section className="card">
              <h2>{isCheckout ? "Not on the receipt" : "Items involved"}</h2>
              <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {incident.unscanned_items.map((item, i) => (
                  <li key={i} className="row">
                    <span>{item.description}</span>
                    <span className="time">{item.t}</span>
                    <span className="spacer" />
                    <strong>{item.price_inr != null ? inr(item.price_inr) : "price unknown"}</strong>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="card stack" aria-labelledby="review-title">
            <h2 id="review-title">Human review</h2>
            {current.status === "NEEDS_REVIEW" ? (
              <>
                <p className="muted small" style={{ margin: 0 }}>
                  ShrinkSight flags events; a person always makes the call.
                </p>
                <div className="row">
                  <button type="button" className="btn btn-success" disabled={reviewing} onClick={() => review("confirm")}>
                    ✓ Confirm
                  </button>
                  <button type="button" className="btn btn-danger" disabled={reviewing} onClick={() => review("dismiss")}>
                    ✗ Dismiss
                  </button>
                </div>
              </>
            ) : current.status === "REJECTED" ? (
              <p style={{ margin: 0 }}>Gemini rejected this alert, so nobody was disturbed.</p>
            ) : (
              <p style={{ margin: 0 }}>
                {current.status === "RESOLVED_CONFIRMED" ? "Confirmed" : "Dismissed"} by staff
                {current.reviewed_at ? ` · ${dateTime(current.reviewed_at)}` : ""}.
              </p>
            )}
            {error && <ErrorNotice>{error}</ErrorNotice>}
            <p className="muted small" style={{ margin: 0 }}>
              Model: {incident.model}
              {incident.latency_ms ? ` · ${(incident.latency_ms / 1000).toFixed(1)} s` : ""}
            </p>
          </section>
        </div>
      </div>
    </article>
  );
}
