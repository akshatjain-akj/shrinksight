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

export type Hand = "left" | "right";
export type BodySpot = "pocket" | "bag" | "shirt" | "waistband";

/** Investigate's Tier-1 measurements: times (clip seconds) and places only, no conclusions. */
export interface ShelfContact {
  hand: Hand;
  start_s: number;
  end_s: number;
}

export interface BodyHold {
  hand: Hand;
  start_s: number;
  end_s: number;
  /** Where the wrist rested; geometry only (a phone pocketed and a stolen item look the same here). */
  spot: BodySpot;
  /** When that hand last left the shelf before this hold. */
  after_shelf_s: number;
}

export interface Trip {
  /** Last time a hand was in the item pile before this trip, and when it reached the bagging area. */
  start_s: number;
  end_s: number;
  via_scanner: boolean;
}

export interface CloseUpRef {
  label: string;
  t_s: number;
  moment: "shelf_exit" | "hold" | "bagging";
}

export interface Tier1Measure {
  gate_opened: boolean;
  opened_at_s?: number | null;
  peak_score: number;
  person_seen: number;
  shelf_contacts: ShelfContact[];
  holds: BodyHold[];
  /** Null when trips can't be counted (not a checkout, or pile / scanner / bagging zone not marked). */
  trips: Trip[] | null;
  close_ups: CloseUpRef[];
}

export interface CameraPrefs {
  camera_id: string;
  person: boolean;
  concealment: boolean;
  loitering: boolean;
  loiter_seconds: number;
  shelf_reach: boolean;
  health_hazard: boolean;
}

export interface RosterPerson {
  id: string;
  email: string;
  name: string;
  role: "manager" | "user";
  enabled: boolean;
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
  /** Where the item finished up ("hand_or_pocket" only on older incidents). */
  ended_in?: "bag" | "in_hand" | "concealed" | "hand_or_pocket" | "pile" | "put_back" | "unclear";
  /** Where it was first picked up; own_clothing_or_bag means a personal item. */
  came_from?: "shelf" | "pile" | "counter" | "own_clothing_or_bag" | "unclear";
  /** Chain of custody, clip timestamps. */
  picked_up_at?: string | null;
  scanner_at?: string | null;
  ended_at?: string | null;
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
  /** A past manager decision on this camera that Gemini found similar, e.g. "4 Oct: personal phone". */
  similar_past_case?: string | null;
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

/** Tokens Gemini used, summed over a step's calls. */
export interface TokenUsage {
  input: number;
  output: number;
  thinking: number;
  total: number;
  calls?: number;
}

export type DismissReason = "personal_item" | "rescan" | "bagging" | "staff" | "camera" | "other";
export type ConfirmReason = "missed_scan" | "concealed" | "other";

/** A past manager decision shown to Gemini for this investigation. */
export interface MemoryRef {
  incident_id: string;
  decision: "confirm" | "dismiss";
  reason: string | null;
  reviewed_at: string;
}

/** How strict the browser's Tier-1 gate is for one camera (auto-tuned by the server). */
export interface EdgeConfig {
  camera_id: string;
  level: number;
  send_score: number;
  hot_frames: number;
  hold_extra_ms: number;
  reason: string;
  changed_at: string | null;
  previous_level: number | null;
  false_alarms: number;
  alerts: number;
  since: string | null;
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
  video_crop?: number[] | null;
  /** "edge" when the Live edge gate sent the clip. */
  origin?: "edge" | "upload" | null;
  edge_confidence?: number | null;
  /** Investigate's on-device Tier-1 screening: its gate opened, or it cleared the clip and staff sent it anyway. */
  tier1_screen?: "flagged" | "cleared" | null;
  tier1_measure?: Tier1Measure | null;
  /** The configured main model, when a backup model answered instead (rate limit, quota or outage). */
  fallback_from?: string | null;
  usage?: TokenUsage | null;
  inventory_usage?: TokenUsage | null;
  memory_used?: MemoryRef[];
  /** Whether Gemini saw a scanner reference photo: uploaded with this clip, or the camera's saved one. */
  scanner_photo?: "clip" | "saved" | null;
  review_reason?: string | null;
  review_note?: string | null;
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
