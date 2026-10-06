"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { clipSeconds, dateTime, inr } from "@/lib/format";
import { flaggedItem, visibleMarks } from "@/lib/marks";
import type { ConfirmReason, DismissReason, Incident, SeenItem, TokenUsage } from "@/lib/types";
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

// Temporary logging to watch token use while we tune prompts; flip to false to hide it.
const SHOW_TOKENS = true;

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));

function tokenText(usage?: TokenUsage | null, inventory?: TokenUsage | null): string {
  if (!usage) return "";
  const parts = [`${k(usage.input)} in`, `${k(usage.output)} out`];
  if (usage.thinking) parts.push(`${k(usage.thinking)} thinking`);
  if (usage.calls && usage.calls > 1) parts.push(`${usage.calls} calls`);
  if (inventory?.total) parts.push(`item list ${k(inventory.total)}`);
  const total = usage.total + (inventory?.total ?? 0);
  return `Tokens: ${k(total)} total (${parts.join(" · ")})`;
}

const DISMISS_REASONS: [DismissReason, string][] = [
  ["personal_item", "Personal item"],
  ["rescan", "Rescan"],
  ["bagging", "Bagging gesture"],
  ["staff", "Staff action"],
  ["camera", "Camera or footage issue"],
  ["other", "Other"],
];

const CONFIRM_REASONS: [ConfirmReason, string][] = [
  ["missed_scan", "Item not scanned"],
  ["concealed", "Item concealed"],
  ["other", "Other"],
];

const REASON_LABEL: Record<string, string> = Object.fromEntries([...DISMISS_REASONS, ...CONFIRM_REASONS]);

const LOCATION_TEXT: Record<string, string> = {
  over_scanner: "passed over the scanner",
  beside_scanner: "went beside the scanner",
  hidden_under_item: "hidden under another item",
  never_near_scanner: "never near the scanner",
};

const CAME_FROM_TEXT: Record<string, string> = {
  shelf: "from the shelf area",
  pile: "from the item pile",
  counter: "from the counter",
  own_clothing_or_bag: "the person's own item",
};

const ENDED_TEXT: Record<string, string> = {
  bag: "ended in the bag",
  in_hand: "still in their hand",
  concealed: "concealed (pocket, clothing or bag)",
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
  // Where the video is (seconds); boxes are drawn only around their item's moment. Null without a video.
  const [playhead, setPlayhead] = useState<number | null>(videoUrl ? 0 : null);
  const marks = visibleMarks(incident.verdict.seen_items, focus, videoUrl ? playhead : null);
  const hasBoxes = incident.verdict.seen_items.some((item) => item.box_2d?.length === 4);
  const note = videoUrl
    ? null
    : incident.source === "seed"
      ? "Example incident · footage for the demo store is coming soon"
      : "Clips aren’t stored. ShrinkSight analyses them and keeps only the report (privacy by design).";

  return (
    <div>
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
              // Open paused on the flagged item's moment, where its box belongs.
              if (focus?.box_2d?.length === 4) v.currentTime = Math.min(clipSeconds(focus.t), v.duration || Infinity);
            }}
            onTimeUpdate={(e) => setPlayhead(e.currentTarget.currentTime)}
            onSeeked={(e) => setPlayhead(e.currentTarget.currentTime)}
          />
        )}
        {marks.map((item) => {
          const [ymin, xmin, ymax, xmax] = item.box_2d;
          return (
            <div
              key={`${item.t}-${item.description}`}
              className={`bbox${item === focus ? "" : " other"}`}
              style={{
                top: `${ymin / 10}%`,
                left: `${xmin / 10}%`,
                height: `${(ymax - ymin) / 10}%`,
                width: `${(xmax - xmin) / 10}%`,
              }}
            >
              <span>
                {item.description} · {item.t}
              </span>
            </div>
          );
        })}
        {note && <p className="evidence-note">{note}</p>}
      </div>
      {videoUrl && hasBoxes && (
        <p className="muted small mark-note">
          Boxes are Gemini’s approximate position, shown around each item’s moment. Click an item to jump to it.
        </p>
      )}
    </div>
  );
}

export default function IncidentDetail({ incident, videoUrl }: { incident: Incident; videoUrl?: string }) {
  const { verdict } = incident;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [focus, setFocus] = useState<SeenItem | null>(
    () => flaggedItem(verdict.seen_items),
  );
  const [current, setCurrent] = useState(incident);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The decision being made: staff pick a reason, which becomes this camera's memory for Gemini.
  const [pending, setPending] = useState<"confirm" | "dismiss" | null>(null);
  const [reason, setReason] = useState<DismissReason | ConfirmReason | null>(null);
  const [note, setNote] = useState("");

  const seek = (t: string, item?: SeenItem) => {
    if (item) setFocus(item);
    if (videoRef.current) {
      videoRef.current.currentTime = clipSeconds(t);
      videoRef.current.pause();
    }
  };

  const startReview = (decision: "confirm" | "dismiss") => {
    setPending(decision);
    setReason(null);
    setNote("");
    setError(null);
  };

  const review = async () => {
    if (!pending || reviewing) return;
    const trimmed = note.trim();
    const chosen = reason ?? (trimmed ? "other" : null);
    if (pending === "dismiss" && !chosen) {
      setError("Pick a reason or write a note first.");
      return;
    }
    setReviewing(true);
    setError(null);
    try {
      setCurrent(await api.review(incident.id, pending, chosen, trimmed));
      setPending(null);
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
              {incident.scanner_photo && (
                <span className="chip" title="Gemini compared every scan with a reference photo of this checkout's scanner">
                  {incident.scanner_photo === "clip" ? "Scanner photo used" : "Camera’s scanner photo used"}
                </span>
              )}
              {incident.origin === "edge" && <span className="chip">Sent by the live edge</span>}
              {incident.tier1_screen === "flagged" && (
                <span className="chip" title="The on-device Tier-1 check screened this clip first and its gate opened">
                  Tier-1 gate: would send
                  {incident.edge_confidence != null ? ` · ${Math.round(incident.edge_confidence * 100)}%` : ""}
                </span>
              )}
              {incident.tier1_screen === "cleared" && (
                <span className="chip" title="Tier-1's gate stayed shut on this clip; staff sent it to Gemini">
                  Tier-1 gate: would not have sent
                </span>
              )}
              {incident.tier1_measure && (
                <span className="chip" title="Tier-1's hand measurements and close-ups went to Gemini as moments to look at">
                  Tier-1 measurements used
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
          {verdict.similar_past_case && (
            <p className="memory-note small" style={{ margin: 0 }}>
              <strong>Like a past decision on this camera:</strong> {verdict.similar_past_case}
            </p>
          )}
          {incident.memory_used && incident.memory_used.length > 0 && (
            <details className="small">
              <summary>
                Gemini used {incident.memory_used.length} past decision{incident.memory_used.length === 1 ? "" : "s"} from
                this camera
              </summary>
              <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem" }}>
                {incident.memory_used.map((m) => (
                  <li key={m.incident_id}>
                    {dateTime(m.reviewed_at)} · {m.decision === "dismiss" ? "Dismissed" : "Confirmed"}
                    {m.reason ? ` (${REASON_LABEL[m.reason] ?? m.reason})` : ""} ·{" "}
                    <Link href={`/incident?id=${encodeURIComponent(m.incident_id)}`}>open</Link>
                  </li>
                ))}
              </ul>
              <p className="muted" style={{ margin: "0.3rem 0 0" }}>
                Past decisions are context only. The till receipt check always has the final say on what was paid.
              </p>
            </details>
          )}
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
                        {(item.picked_up_at || item.scanner_at || item.ended_at) && (
                          <span className="seen-meta">
                            {[
                              item.picked_up_at ? `picked up ${item.picked_up_at}` : null,
                              item.scanner_at ? `scanner ${item.scanner_at}` : "never at the scanner",
                              item.ended_at ? `${item.ended_in && item.ended_in !== "unclear" ? ENDED_TEXT[item.ended_in] : "ended"} ${item.ended_at}` : null,
                            ]
                              .filter(Boolean)
                              .join(" → ")}
                          </span>
                        )}
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

          {!isCheckout && verdict.seen_items.length > 0 && (
            <section className="card" aria-labelledby="handled-title">
              <h2 id="handled-title">What the person handled</h2>
              <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {verdict.seen_items.map((item, i) => (
                  <li key={i}>
                    <button type="button" className="linkish" onClick={() => seek(item.t, item)}>
                      {item.description}
                    </button>{" "}
                    <span className="time">{item.t}</span>
                    <span className="seen-meta">
                      {[
                        item.came_from && item.came_from !== "unclear" ? CAME_FROM_TEXT[item.came_from] : null,
                        item.picked_up_at ? `picked up ${item.picked_up_at}` : null,
                        item.ended_in && item.ended_in !== "unclear"
                          ? `${ENDED_TEXT[item.ended_in]}${item.ended_at ? ` ${item.ended_at}` : ""}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" → ") || "path unclear"}
                    </span>
                  </li>
                ))}
              </ul>
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
            {pending ? (
              <form
                className="stack"
                style={{ gap: "0.5rem" }}
                onSubmit={(event) => {
                  event.preventDefault();
                  void review();
                }}
              >
                <p className="small" style={{ margin: 0 }}>
                  {pending === "dismiss" ? "Why is this not a theft?" : "What happened?"}{" "}
                  <span className="muted">Gemini remembers this for future clips from this camera.</span>
                </p>
                <div className="reason-chips" role="group" aria-label="Reason">
                  {(pending === "dismiss" ? DISMISS_REASONS : CONFIRM_REASONS).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className="btn btn-sm"
                      aria-pressed={reason === value}
                      onClick={() => setReason(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <label className="field small">
                  Note (optional)
                  <input
                    type="text"
                    maxLength={200}
                    value={note}
                    placeholder={pending === "dismiss" ? "e.g. shopper's own phone" : "e.g. razor pack under the cereal"}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </label>
                <div className="row">
                  <button
                    type="submit"
                    className={`btn ${pending === "dismiss" ? "btn-danger" : "btn-success"}`}
                    disabled={reviewing}
                  >
                    {pending === "dismiss" ? "✗ Dismiss" : "✓ Confirm"}
                  </button>
                  <button type="button" className="btn btn-ghost" disabled={reviewing} onClick={() => setPending(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : current.status === "NEEDS_REVIEW" ? (
              <>
                <p className="muted small" style={{ margin: 0 }}>
                  ShrinkSight flags events; a person always makes the call.
                </p>
                <div className="row">
                  <button type="button" className="btn btn-success" disabled={reviewing} onClick={() => startReview("confirm")}>
                    ✓ Confirm
                  </button>
                  <button type="button" className="btn btn-danger" disabled={reviewing} onClick={() => startReview("dismiss")}>
                    ✗ Dismiss
                  </button>
                </div>
              </>
            ) : current.status === "REJECTED" ? (
              <>
                <p style={{ margin: 0 }}>
                  Gemini rejected this alert, so nobody was disturbed.
                  {incident.receipt_check && (
                    <span className="seen-meta">Why: {incident.receipt_check.replace(/^Receipt check: /, "")}</span>
                  )}
                </p>
                <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => startReview("confirm")}>
                  Gemini got this wrong? Mark it as a theft
                </button>
              </>
            ) : (
              <p style={{ margin: 0 }}>
                {current.status === "RESOLVED_CONFIRMED" ? "Confirmed" : "Dismissed"} by staff
                {current.review_reason ? ` (${REASON_LABEL[current.review_reason] ?? current.review_reason})` : ""}
                {current.reviewed_at ? ` · ${dateTime(current.reviewed_at)}` : ""}.
                {current.review_note && <span className="seen-meta">Note: {current.review_note}</span>}
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
            {SHOW_TOKENS && incident.usage && (
              <p className="muted small token-log" style={{ margin: 0 }}>
                {tokenText(incident.usage, incident.inventory_usage)}
              </p>
            )}
          </section>
          <AskPanel incident={current} />
        </div>
      </div>
    </article>
  );
}
