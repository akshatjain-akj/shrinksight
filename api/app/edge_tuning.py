"""Self-calibrating edge gate: if the browser's Tier-1 gate keeps sending junk, it gets one step stricter.

After every edge alert is investigated or reviewed, the camera's recent edge alerts are counted. When most of them
were false alarms (Gemini rejected them, or staff dismissed them), the gate moves up one level: a higher score, more
consecutive hot frames and a longer concealment hold before a clip is sent. When nearly all were real, it relaxes
one level. Levels are fixed and bounded, every change is explained and can be undone, and a change starts a fresh
counting window so one burst of alerts can't move it twice. The result is written to Firestore (edge_config/{camera})
and the browser picks it up live.
"""

from datetime import UTC, datetime

from .config import Settings
from .models import EdgeConfig, Incident
from .repo import Repo

# (send score, consecutive hot frames, extra concealment hold in ms). Level 0 is the engine's built-in default.
LEVELS: list[tuple[float, int, int]] = [
    (0.40, 8, 0),
    (0.45, 10, 300),
    (0.50, 12, 600),
    (0.55, 15, 900),
]
RAISE_AT = 0.7  # share of false alarms that makes the gate stricter
RELAX_AT = 0.2  # share of false alarms at or below which a stricter gate relaxes one level
# A confirmed theft whose edge score was within this margin of the stricter threshold blocks raising it.
NEAR_MISS = 0.1

FALSE_ALARM = {"REJECTED", "RESOLVED_DISMISSED"}


def _now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def config_for(camera_id: str, level: int, **extra) -> EdgeConfig:
    level = max(0, min(level, len(LEVELS) - 1))
    score, frames, hold = LEVELS[level]
    return EdgeConfig(camera_id=camera_id, level=level, send_score=score, hot_frames=frames, hold_extra_ms=hold,
                      **extra)


def current(repo: Repo, camera_id: str) -> EdgeConfig:
    return repo.get_edge_config(camera_id) or config_for(camera_id, 0)


def edge_alerts(incidents: list[Incident], camera_id: str, since: str | None) -> list[Incident]:
    """This camera's edge alerts after `since`, newest first."""
    return [
        i for i in incidents
        if i.camera_id == camera_id and i.origin == "edge" and (since is None or i.created_at > since)
    ]


def decide(config: EdgeConfig, alerts: list[Incident], settings: Settings) -> EdgeConfig | None:
    """The new config if the gate should change, else None. Pure, so it can be unit-tested."""
    need = max(1, settings.edge_tune_min_alerts)
    window = alerts[: max(need, settings.edge_tune_window)]
    if len(window) < need:
        return None
    false_alarms = sum(1 for i in window if i.status in FALSE_ALARM)
    ratio = false_alarms / len(window)
    level = config.level
    counts = {"false_alarms": false_alarms, "alerts": len(window)}

    if ratio >= RAISE_AT and level < len(LEVELS) - 1:
        stricter = LEVELS[level + 1][0]
        near_miss = any(
            i.status == "RESOLVED_CONFIRMED" and i.edge_confidence is not None
            and i.edge_confidence < stricter + NEAR_MISS
            for i in window
        )
        if near_miss:
            return None
        reason = (f"{false_alarms} of the last {len(window)} edge alerts were false alarms, so the gate is stricter: "
                  f"score {LEVELS[level][0]:.2f} → {stricter:.2f}, {LEVELS[level][1]} → {LEVELS[level + 1][1]} "
                  f"hot frames.")
        return config_for(config.camera_id, level + 1, reason=reason, previous_level=level, **counts)
    if ratio <= RELAX_AT and level > 0:
        looser = LEVELS[level - 1]
        reason = (f"Only {false_alarms} of the last {len(window)} edge alerts were false alarms, so the gate relaxed: "
                  f"score {LEVELS[level][0]:.2f} → {looser[0]:.2f}.")
        return config_for(config.camera_id, level - 1, reason=reason, previous_level=level, **counts)
    return None


def retune(repo: Repo, camera_id: str, settings: Settings) -> EdgeConfig | None:
    """Re-evaluates one camera after an edge alert was investigated or reviewed. Saves and returns a change."""
    config = current(repo, camera_id)
    alerts = edge_alerts(repo.incidents(100), camera_id, config.since)
    changed = decide(config, alerts, settings)
    if changed is None:
        return None
    now = _now_iso()
    changed.changed_at = now
    changed.since = now
    repo.save_edge_config(changed)
    return changed


def undo(repo: Repo, camera_id: str) -> EdgeConfig:
    """Back to the previous level (or the default), starting a fresh window."""
    config = current(repo, camera_id)
    target = config.previous_level if config.previous_level is not None else 0
    now = _now_iso()
    restored = config_for(camera_id, target, reason="Undone by staff.", previous_level=config.level,
                          changed_at=now, since=now)
    repo.save_edge_config(restored)
    return restored
