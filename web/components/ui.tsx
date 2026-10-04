import type { ReactNode } from "react";
import { STATUS_LABEL, VERDICT_LABEL } from "@/lib/format";
import type { IncidentStatus, VerdictKind } from "@/lib/types";

export function verdictTone(verdict: VerdictKind): "danger" | "warning" | "neutral" {
  if (verdict === "SCAN_AVOIDANCE" || verdict === "CONCEALMENT") return "danger";
  if (verdict === "RULE_BREACH" || verdict === "INCONCLUSIVE") return "warning";
  return "neutral";
}

export function VerdictBadge({ verdict, confidence }: { verdict: VerdictKind; confidence?: number }) {
  return (
    <span className={`chip tone-${verdictTone(verdict)}`}>
      {VERDICT_LABEL[verdict]}
      {confidence !== undefined && ` · ${Math.round(confidence * 100)}%`}
    </span>
  );
}

const STATUS_TONE: Record<IncidentStatus, string> = {
  NEEDS_REVIEW: "warning",
  REJECTED: "neutral",
  RESOLVED_CONFIRMED: "danger",
  RESOLVED_DISMISSED: "success",
};

export function StatusPill({ status }: { status: IncidentStatus }) {
  return <span className={`chip tone-${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row" role="status">
      <span className="spinner" aria-hidden="true" />
      {label && <span className="muted small">{label}</span>}
    </span>
  );
}

export function ErrorNotice({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div className="notice error row" role="alert">
      <span>{children}</span>
      {onRetry && (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Skeletons({ count = 3 }: { count?: number }) {
  return (
    <div className="stack" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton" />
      ))}
    </div>
  );
}
