"use client";

import Link from "next/link";
import { VERDICT_LABEL } from "@/lib/format";
import type { VerdictKind } from "@/lib/types";

export interface SendEntry {
  id: number;
  at: string;
  trigger: string;
  /** Length of the clip that was sent. */
  seconds: number;
  status: "reviewing" | "done" | "error";
  verdict?: VerdictKind;
  reason?: string;
  incidentId?: string;
  cached?: boolean;
  /** Object URL of exactly what Gemini received (kept for the last few sends only). */
  clipUrl?: string;
}

/** The last few clips Live edge sent: why, what Gemini said, and the clip itself to download. */
export default function EdgeSendLog({ sends }: { sends: SendEntry[] }) {
  if (!sends.length) return null;
  return (
    <section aria-labelledby="send-log-title" className="stack" style={{ gap: "0.5rem" }}>
      <h3 id="send-log-title" style={{ margin: 0 }}>Sent to Gemini</h3>
      <ol className="send-log">
        {sends.map((entry) => (
          <li key={entry.id}>
            <div className="row" style={{ gap: "0.4rem" }}>
              <span className="time">{entry.at}</span>
              {entry.status === "reviewing" && <span className="chip">Reviewing…</span>}
              {entry.status === "error" && <span className="chip tone-danger">Failed</span>}
              {entry.verdict && (
                <span className={`chip ${entry.verdict === "BENIGN" ? "" : "tone-warning"}`}>
                  {VERDICT_LABEL[entry.verdict] ?? entry.verdict}
                  {entry.cached ? " · cached" : ""}
                </span>
              )}
              <span className="spacer" />
              {entry.incidentId && <Link href={`/incident?id=${encodeURIComponent(entry.incidentId)}`}>Open</Link>}
              {entry.clipUrl && (
                <a href={entry.clipUrl} download={`shrinksight-edge-${entry.id}.webm`}>
                  Download clip
                </a>
              )}
            </div>
            <span className="muted small">
              {entry.trigger} · {entry.seconds.toFixed(1)} s clip
            </span>
            {entry.reason && <span className="small send-reason">{entry.reason}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
