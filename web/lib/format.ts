import type { Incident, VerdictKind } from "./types";

const inrFormatter = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

export function inr(value: number): string {
  return inrFormatter.format(value);
}

export function timeAgo(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** "00:06.4" or "6.4" -> seconds */
export function clipSeconds(t: string): number {
  const parts = t.split(":").map(Number);
  if (parts.some(Number.isNaN)) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

export const VERDICT_LABEL: Record<VerdictKind, string> = {
  SCAN_AVOIDANCE: "Scan avoidance",
  CONCEALMENT: "Concealment",
  RULE_BREACH: "Rule breach",
  BENIGN: "False alarm",
  INCONCLUSIVE: "Inconclusive",
};

export const STATUS_LABEL = {
  NEEDS_REVIEW: "Needs review",
  REJECTED: "Rejected by Gemini",
  RESOLVED_CONFIRMED: "Confirmed",
  RESOLVED_DISMISSED: "Dismissed",
} as const;

export function headline(incident: Incident): string {
  const { verdict } = incident.verdict;
  if (verdict === "SCAN_AVOIDANCE") {
    const n = incident.unscanned_items.length || incident.verdict.items_seen - incident.verdict.items_scanned;
    return `${n} item${n === 1 ? "" : "s"} not scanned`;
  }
  if (verdict === "CONCEALMENT") return "Possible concealment";
  if (verdict === "RULE_BREACH") return "Store rule breached";
  if (verdict === "BENIGN") return "False alarm rejected";
  return "Inconclusive, needs a look";
}

export function isFlagged(incident: Incident): boolean {
  return (
    ["SCAN_AVOIDANCE", "CONCEALMENT", "RULE_BREACH"].includes(incident.verdict.verdict) &&
    incident.status !== "RESOLVED_DISMISSED"
  );
}

export function summarise(incidents: Incident[]) {
  const flagged = incidents.filter(isFlagged);
  return {
    investigated: incidents.length,
    flagged: flagged.length,
    rejected: incidents.filter((i) => i.status === "REJECTED").length,
    needsReview: incidents.filter((i) => i.status === "NEEDS_REVIEW").length,
    lossCaught: flagged.reduce((sum, i) => sum + i.est_loss_inr, 0),
  };
}
