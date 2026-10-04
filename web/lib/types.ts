// Mirrors api/app/models.py. Keep the two in sync when either changes.

export type CameraKind = "checkout" | "floor";
export type VerdictKind = "SCAN_AVOIDANCE" | "CONCEALMENT" | "RULE_BREACH" | "BENIGN" | "INCONCLUSIVE";
export type IncidentStatus = "NEEDS_REVIEW" | "REJECTED" | "RESOLVED_CONFIRMED" | "RESOLVED_DISMISSED";
export type RuleType = "DWELL" | "ZONE_ENTRY" | "CONCEALMENT_SENSITIVITY" | "SCANNER_BYPASS";
export type ConcealmentOf = "pocket" | "bag" | "shirt" | "waistband";
export type Severity = "LOW" | "MEDIUM" | "HIGH";

export interface Zone {
  id: string;
  name: string;
  camera_id: string;
  kind: "scanner" | "bagging" | "shelf" | "exit";
  high_value: boolean;
}

export interface Camera {
  id: string;
  name: string;
  kind: CameraKind;
  lane_id: string | null;
  zone_ids: string[];
}

export interface Store {
  name: string;
  currency: string;
  cameras: Camera[];
  zones: Zone[];
}

export interface ReceiptLine {
  name: string;
  price_inr: number;
  sku?: string | null;
}

export interface Transaction {
  id: string;
  lane_id: string;
  lines: ReceiptLine[];
  started_at: string;
  total_inr: number;
}

export interface SeenItem {
  t: string;
  description: string;
  scanned: boolean;
  box_2d: number[];
}

export interface TimelineEvent {
  t: string;
  event: string;
}

export interface Verdict {
  verdict: VerdictKind;
  confidence: number;
  items_seen: number;
  items_scanned: number;
  seen_items: SeenItem[];
  timeline: TimelineEvent[];
  reason: string;
}

export interface UnscannedItem {
  t: string;
  description: string;
  price_inr: number | null;
  matched_sku: string | null;
}

export interface Incident {
  id: string;
  created_at: string;
  camera_id: string;
  camera_name: string;
  camera_kind: CameraKind;
  status: IncidentStatus;
  verdict: Verdict;
  receipt: ReceiptLine[];
  transaction_id: string | null;
  unscanned_items: UnscannedItem[];
  est_loss_inr: number;
  model: string;
  source: "seed" | "live";
  latency_ms: number | null;
  tool_calls: { name: string; args: Record<string, unknown> }[];
  reviewed_at: string | null;
}

export interface RuleSpec {
  supported: boolean;
  unsupported_reason: string | null;
  type: RuleType | null;
  zone_id: string | null;
  min_seconds: number | null;
  active_from: string | null;
  active_to: string | null;
  sensitivity: "low" | "medium" | "high" | null;
  concealment_of?: ConcealmentOf | null;
  severity: Severity;
  summary: string;
}

export interface Rule {
  id: string;
  source_text: string;
  spec: RuleSpec;
  enabled: boolean;
  created_at: string;
  source: "seed" | "live";
}

export type InvestigationEvent =
  | { type: "progress"; step: string; label: string; tool?: string; args?: Record<string, unknown> }
  | { type: "result"; incident: Incident; cached: boolean }
  | { type: "error"; message: string };
