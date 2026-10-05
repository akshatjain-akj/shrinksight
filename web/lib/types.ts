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
  kind: "pickup" | "scanner" | "bagging" | "shelf" | "exit";
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

export type ItemLocation = "over_scanner" | "beside_scanner" | "hidden_under_item" | "never_near_scanner" | "unclear";

export interface SeenItem {
  t: string;
  description: string;
  scanned: boolean;
  box_2d: number[];
  receipt_line?: number | null;
  location?: ItemLocation;
  /** # in the confirmed item list, or null for an extra item. */
  inventory_id?: number | null;
  /** Where the item finished up. */
  ended_in?: "bag" | "hand_or_pocket" | "pile" | "put_back" | "unclear";
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
  /** Every separate item in the item pile at the start, each located with a box. */
  inventory?: { description: string; box_2d: number[] }[];
  /** Older incidents: plain names. */
  starting_items?: string[];
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

/** A marked zone in a camera's picture. Points are normalised 0–1, origin top-left. */
export interface ZoneHint {
  zone_id: string;
  kind: Zone["kind"];
  polygon: { x: number; y: number }[];
  description: string;
}

export interface CameraLayout {
  camera_id: string;
  zones: ZoneHint[];
  updated_at: string;
}

export interface ZoneSuggestion {
  zone_id: string;
  found: boolean;
  box_2d: number[];
  description: string;
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
  zones_used?: ZoneHint[];
  /** Where the investigation's time went, in ms (lookup, upload, watch, recheck, total). */
  timings?: Record<string, number>;
  /** The server's receipt check: why it was rejected, or why Gemini's verdict was overridden. */
  receipt_check?: string | null;
  overridden?: boolean;
}

export interface InventoryItem {
  description: string;
  /** [ymin, xmin, ymax, xmax] 0–1000 in the item-pile close-up; empty for items you typed in. */
  box_2d: number[];
}

export interface AskAnswer {
  answer: string;
  steps: { tool: string; label: string; args: Record<string, unknown> }[];
  model: string;
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
