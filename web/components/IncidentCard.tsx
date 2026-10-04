import Link from "next/link";
import { headline, inr, timeAgo } from "@/lib/format";
import type { Incident } from "@/lib/types";
import { StatusPill, verdictTone } from "./ui";

export default function IncidentCard({ incident, now }: { incident: Incident; now: number }) {
  const tone = verdictTone(incident.verdict.verdict);
  return (
    <Link href={`/incident?id=${encodeURIComponent(incident.id)}`} className={`incident-card ${tone}`}>
      <div className="row small">
        <span className="muted">{incident.camera_name}</span>
        <span className="spacer" />
        <span className="time">{timeAgo(incident.created_at, now)}</span>
      </div>
      <h3>
        {headline(incident)}
        {incident.est_loss_inr > 0 && <> · {inr(incident.est_loss_inr)}</>}
      </h3>
      <p>{incident.verdict.reason}</p>
      <div className="row" style={{ marginTop: "0.4rem" }}>
        <StatusPill status={incident.status} />
        {incident.source === "seed" && <span className="chip">Example</span>}
      </div>
    </Link>
  );
}
