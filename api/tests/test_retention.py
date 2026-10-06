"""Playback retention: false alarms after 1 day, theft and hazards after 7 days. Seed clips stay."""

from datetime import UTC, datetime, timedelta

from app.models import Incident
from app.seed import INCIDENTS


def _iso(age: timedelta) -> str:
    return (datetime.now(UTC) - age).strftime("%Y-%m-%dT%H:%M:%SZ")


def _live(base: Incident, incident_id: str, age: timedelta, **updates) -> Incident:
    return base.model_copy(update={"id": incident_id, "created_at": _iso(age), "source": "live", **updates})


def test_playback_deletes_by_age_and_type(api):
    false_alarm = next(item for item in INCIDENTS if item.verdict.verdict == "BENIGN")
    theft = next(item for item in INCIDENTS if item.verdict.verdict == "SCAN_AVOIDANCE")
    hazard = false_alarm.model_copy(
        update={
            "verdict": false_alarm.verdict.model_copy(
                update={"reason": "A spill on the floor is a health hazard."}
            )
        }
    )
    repo = api.repo
    repo.save_incident(_live(false_alarm, "live-false-old", timedelta(days=2)))
    repo.save_incident(_live(false_alarm, "live-false-fresh", timedelta(hours=3)))
    repo.save_incident(_live(theft, "live-theft-old", timedelta(days=8)))
    repo.save_incident(_live(theft, "live-theft-week", timedelta(days=3)))
    repo.save_incident(_live(hazard, "live-hazard-old", timedelta(days=2)))

    ids = {item["id"] for item in api.get("/api/incidents?limit=100").json()}

    assert "live-false-old" not in ids
    assert "live-false-fresh" in ids
    assert "live-theft-old" not in ids
    assert "live-theft-week" in ids
    assert "live-hazard-old" in ids
    assert "inc-seed-003" in ids
