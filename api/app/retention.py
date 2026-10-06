"""How long a playback record stays.

False alarms go after 1 day. A real theft or a hazard stays 7 days. Seeded demo incidents are never removed.
"""

from datetime import UTC, datetime

FALSE_ALARM_SECONDS = 24 * 60 * 60
REAL_EVENT_SECONDS = 7 * 24 * 60 * 60
REAL_VERDICTS = {"SCAN_AVOIDANCE", "CONCEALMENT", "RULE_BREACH"}
# The purge sweeps at most this often per instance, so listing incidents stays cheap on Firestore reads
PURGE_EVERY_S = 60 * 60


def _created(doc: dict) -> datetime | None:
    raw = str(doc.get("created_at") or "")
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def is_false_alarm(doc: dict) -> bool:
    """Staff-closed false alarms last 1 day. Confirmed theft and hazards last 7 days."""
    verdict = (doc.get("verdict") or {}).get("verdict")
    status = doc.get("status")
    text = " ".join(
        [
            str((doc.get("verdict") or {}).get("reason") or ""),
            " ".join(str(event.get("event") or "") for event in (doc.get("verdict") or {}).get("timeline") or []),
        ]
    ).lower()
    if "hazard" in text or "spill" in text or status == "RESOLVED_CONFIRMED":
        return False
    if status in {"REJECTED", "RESOLVED_DISMISSED"} or verdict == "BENIGN":
        return True
    return verdict not in REAL_VERDICTS and status != "NEEDS_REVIEW"


def keep_seconds(doc: dict) -> int:
    """False alarms last 1 day. Theft and hazards last 7 days."""
    if is_false_alarm(doc):
        return FALSE_ALARM_SECONDS
    return REAL_EVENT_SECONDS


def oldest_kept_iso(now: datetime | None = None) -> str:
    """Anything created after this is younger than the shortest retention, so the purge never needs to read it."""
    moment = (now or datetime.now(UTC)).timestamp() - FALSE_ALARM_SECONDS
    return datetime.fromtimestamp(moment, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def is_expired(doc: dict, now: datetime | None = None) -> bool:
    if doc.get("source") == "seed" or str(doc.get("id") or "").startswith("inc-seed-"):
        return False
    created = _created(doc)
    if created is None:
        return False
    moment = now or datetime.now(UTC)
    if created.tzinfo is None:
        created = created.replace(tzinfo=UTC)
    return (moment - created).total_seconds() >= keep_seconds(doc)
