"use client";

import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { clipSeconds, dateTime, inr } from "@/lib/format";
import type { Incident, SeenItem } from "@/lib/types";
import AskPanel from "./AskPanel";
import { ErrorNotice, StatusPill, VerdictBadge } from "./ui";

const TIMING_LABELS: [string, string][] = [
  ["upload_ms", "upload"],
  ["watch_ms", "watching"],
  ["recheck_ms", "re-check"],
  ["total_ms", "total"],
];

function timingText(timings?: Record<string, number>): string {
  if (!timings) return "";
  return TIMING_LABELS.filter(([key]) => timings[key] && timings[key] >= 50)
    .map(([key, label]) => `${label} ${(timings[key] / 1000).toFixed(1)} s`)
    .join(" · ");
}

const LOCATION_TEXT: Record<string, string> = {
  over_scanner: "passed over the scanner",
  beside_scanner: "went beside the scanner",
  hidden_under_item: "hidden under another item",
  never_near_scanner: "never near the scanner",
};

const ENDED_TEXT: Record<string, string> = {
  bag: "ended in the bag",
  hand_or_pocket: "kept by the shopper",
  pile: "stayed in the pile",
  put_back: "was put back",
};

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
              {incident.overridden && (
                <span className="chip tone-warning" title={incident.receipt_check ?? undefined}>
                  Receipt check overrode Gemini’s verdict
                </span>
              )}
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
                {(() => {
                  const pile = verdict.inventory?.length
                    ? verdict.inventory.map((i) => i.description)
                    : (verdict.starting_items ?? []);
                  return pile.length > 0 ? (
                    <span className="seen-meta">
                      In the item pile at the start ({pile.length}): {pile.join(", ")}
                    </span>
                  ) : null;
                })()}
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
                        {item.inventory_id ? <span className="chip tone-accent">#{item.inventory_id}</span> : null}{" "}
                        <button type="button" className="linkish" onClick={() => seek(item.t, item)}>
                          {item.description}
                        </button>{" "}
                        <span className="time">{item.t}</span>
                      </td>
                      <td>
                        {item.scanned ? (
                          <>✓ {item.receipt_line ? `Line ${item.receipt_line}` : "Yes"}</>
                        ) : (
                          <strong style={{ color: "var(--danger)" }}>✗ Not on receipt</strong>
                        )}
                        {(item.location && item.location !== "unclear") || (item.ended_in && item.ended_in !== "unclear") ? (
                          <span className="seen-meta">
                            {[
                              item.location && item.location !== "unclear" ? LOCATION_TEXT[item.location] : null,
                              item.ended_in && item.ended_in !== "unclear" ? ENDED_TEXT[item.ended_in] : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        ) : null}
                      </td>
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
              <p style={{ margin: 0 }}>
                Gemini rejected this alert, so nobody was disturbed.
                {incident.receipt_check && (
                  <span className="seen-meta">Why: {incident.receipt_check.replace(/^Receipt check: /, "")}</span>
                )}
              </p>
            ) : (
              <p style={{ margin: 0 }}>
                {current.status === "RESOLVED_CONFIRMED" ? "Confirmed" : "Dismissed"} by staff
                {current.reviewed_at ? ` · ${dateTime(current.reviewed_at)}` : ""}.
              </p>
            )}
            {error && <ErrorNotice>{error}</ErrorNotice>}
            {incident.overridden && incident.receipt_check && (
              <div className="notice" role="note">
                {incident.receipt_check}
              </div>
            )}
            <p className="muted small" style={{ margin: 0 }}>
              Model: {incident.model}
              {incident.timings
                ? ` · ${timingText(incident.timings)}`
                : incident.latency_ms
                  ? ` · ${(incident.latency_ms / 1000).toFixed(1)} s`
                  : ""}
            </p>
          </section>
          <AskPanel incident={current} />
        </div>
      </div>
    </article>
  );
}
