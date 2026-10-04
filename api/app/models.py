"""Domain models shared by the API, the seed data and the Gemini output schemas."""

import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator

CameraKind = Literal["checkout", "floor"]
ZoneKind = Literal["scanner", "bagging", "shelf", "exit"]
VerdictKind = Literal["SCAN_AVOIDANCE", "CONCEALMENT", "RULE_BREACH", "BENIGN", "INCONCLUSIVE"]
IncidentStatus = Literal["NEEDS_REVIEW", "REJECTED", "RESOLVED_CONFIRMED", "RESOLVED_DISMISSED"]
RuleType = Literal["DWELL", "ZONE_ENTRY", "CONCEALMENT_SENSITIVITY", "SCANNER_BYPASS"]
ConcealmentOf = Literal["pocket", "bag", "shirt", "waistband"]
Severity = Literal["LOW", "MEDIUM", "HIGH"]

POSITIVE_VERDICTS = {"SCAN_AVOIDANCE", "CONCEALMENT", "RULE_BREACH"}
_HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


# ---------- Store ----------
class Zone(BaseModel):
    id: str
    name: str
    camera_id: str
    kind: ZoneKind
    high_value: bool = False


class Camera(BaseModel):
    id: str
    name: str
    kind: CameraKind
    lane_id: str | None = None
    zone_ids: list[str] = []


class Sku(BaseModel):
    sku: str
    name: str
    price_inr: float
    high_value: bool = False


class ReceiptLine(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    price_inr: float = Field(ge=0, le=1_000_000)
    sku: str | None = None


class Transaction(BaseModel):
    id: str
    lane_id: str
    lines: list[ReceiptLine]
    started_at: str
    source: Literal["seed", "live"] = "seed"

    @property
    def total_inr(self) -> float:
        return round(sum(line.price_inr for line in self.lines), 2)


# ---------- Gemini investigation output (structured output schema) ----------
class SeenItem(BaseModel):
    t: str = Field(description="Clip-relative timestamp, e.g. '00:06.4'")
    description: str = Field(description="Short visual description of the item, no brand guesses")
    scanned: bool = Field(description="True only if the item clearly passed over the scanner zone")
    box_2d: list[int] = Field(
        default_factory=list, description="[ymin, xmin, ymax, xmax] normalised 0-1000 at time t"
    )


class TimelineEvent(BaseModel):
    t: str
    event: str


class VerdictOut(BaseModel):
    verdict: VerdictKind
    confidence: float = Field(ge=0, le=1)
    items_seen: int = Field(ge=0)
    items_scanned: int = Field(ge=0)
    seen_items: list[SeenItem] = []
    timeline: list[TimelineEvent] = []
    reason: str = Field(description="One or two plain sentences describing actions only")

    @field_validator("seen_items")
    @classmethod
    def _boxes_well_formed(cls, items: list[SeenItem]) -> list[SeenItem]:
        for item in items:
            if item.box_2d and (len(item.box_2d) != 4 or not all(0 <= v <= 1000 for v in item.box_2d)):
                item.box_2d = []
        return items


# ---------- Incidents ----------
class UnscannedItem(BaseModel):
    t: str
    description: str
    price_inr: float | None = None
    matched_sku: str | None = None


class ToolCallLog(BaseModel):
    name: str
    args: dict


class Incident(BaseModel):
    id: str
    created_at: str
    camera_id: str
    camera_name: str
    camera_kind: CameraKind
    status: IncidentStatus
    verdict: VerdictOut
    receipt: list[ReceiptLine] = []
    transaction_id: str | None = None
    unscanned_items: list[UnscannedItem] = []
    est_loss_inr: float = 0
    model: str
    source: Literal["seed", "live"]
    latency_ms: int | None = None
    tool_calls: list[ToolCallLog] = []
    reviewed_at: str | None = None


def status_for(verdict: VerdictKind) -> IncidentStatus:
    return "REJECTED" if verdict == "BENIGN" else "NEEDS_REVIEW"


# ---------- Rules ----------
class RuleSpec(BaseModel):
    """What Gemini returns for a plain-English rule; validated before it can be saved."""

    supported: bool = Field(description="False if the request can't be expressed with the supported types")
    unsupported_reason: str | None = None
    type: RuleType | None = None
    zone_id: str | None = None
    min_seconds: int | None = Field(default=None, description="DWELL only: seconds before alerting")
    active_from: str | None = Field(default=None, description="HH:MM 24h local time, or null for all day")
    active_to: str | None = Field(default=None, description="HH:MM 24h local time, or null for all day")
    sensitivity: Literal["low", "medium", "high"] | None = None
    concealment_of: ConcealmentOf | None = Field(
        default=None,
        description="Which concealment the rule watches: pocket, bag, shirt, or waistband. Null means all of them.",
    )
    severity: Severity = "MEDIUM"
    summary: str = Field(description="The rule restated in one short plain-English sentence")


class Rule(BaseModel):
    id: str
    source_text: str
    spec: RuleSpec
    enabled: bool = True
    created_at: str
    source: Literal["seed", "live"] = "live"


def validate_rule_spec(spec: RuleSpec, zones: dict[str, Zone]) -> list[str]:
    """Returns human-readable problems; empty list means the rule can be enforced."""
    if not spec.supported:
        return [spec.unsupported_reason or "This rule can't be enforced yet."]
    problems: list[str] = []
    if spec.type is None:
        problems.append("Rule type is missing.")
    if spec.zone_id not in zones:
        problems.append("Pick one of the store's zones for this rule.")
    if spec.type == "DWELL" and not (spec.min_seconds and 5 <= spec.min_seconds <= 3600):
        problems.append("A loitering rule needs a time between 5 seconds and 1 hour.")
    if (spec.active_from is None) != (spec.active_to is None):
        problems.append("Give both a start and an end time, or neither.")
    for value in (spec.active_from, spec.active_to):
        if value is not None and not _HHMM.match(value):
            problems.append(f"'{value}' isn't a valid HH:MM time.")
    return problems
