"""Per-camera memory: a manager's past decisions become short examples in later investigation prompts.

When staff confirm or dismiss an alert (with a reason), a small Feedback record is kept for that camera. Each new
investigation on the camera gets the latest few as plain text: dismissals AND confirmed thefts, so the examples
don't drift towards "everything is fine". Text only (no images), so it adds a few hundred tokens and no requests.
The memory is context, never a rule: the deterministic receipt check still runs after Gemini answers, so a past
dismissal can't clear an unpaid item that went into the bag.
"""

import hashlib

from .models import REVIEW_REASON_TEXT, Feedback, Incident, MemoryRef

MAX_DISMISSALS = 3
MAX_CONFIRMATIONS = 2


def feedback_from(incident: Incident, decision: str, reason: str | None, note: str, reviewed_at: str) -> Feedback:
    items = [u.description for u in incident.unscanned_items]
    if not items:
        items = [s.description for s in incident.verdict.seen_items if not s.scanned]
    return Feedback(
        incident_id=incident.id,
        camera_id=incident.camera_id,
        decision=decision,
        reason=reason,
        note=note.strip()[:200],
        verdict=incident.verdict.verdict,
        summary=incident.verdict.reason[:300],
        items=items[:5],
        reviewed_at=reviewed_at,
    )


def pick(feedback: list[Feedback], limit: int) -> list[Feedback]:
    """The newest dismissals and confirmations (balanced), newest first, at most `limit`."""
    if limit <= 0:
        return []
    newest = sorted(feedback, key=lambda f: f.reviewed_at, reverse=True)
    dismissed = [f for f in newest if f.decision == "dismiss"][:MAX_DISMISSALS]
    confirmed = [f for f in newest if f.decision == "confirm"][:MAX_CONFIRMATIONS]
    chosen = sorted(dismissed + confirmed, key=lambda f: f.reviewed_at, reverse=True)
    return chosen[:limit]


def _day(iso: str) -> str:
    return iso[:10]


def memory_text(chosen: list[Feedback]) -> str:
    if not chosen:
        return ""
    lines = []
    for f in chosen:
        why = REVIEW_REASON_TEXT.get(f.reason or "", f.reason or "no reason given")
        action = "DISMISSED" if f.decision == "dismiss" else "CONFIRMED"
        items = f" Items: {', '.join(f.items)}." if f.items else ""
        note = f" Manager's note: {f.note}" if f.note else ""
        lines.append(f'- {_day(f.reviewed_at)}: the manager {action} a {f.verdict} alert ({why}). Gemini had said: '
                     f'"{f.summary}"{items}{note}')
    return (
        "This store's past review decisions on this camera (newest first). Use them to recognise the store's normal "
        "routines and its real thefts. They are context, not rules: judge this clip on what it shows, and the till "
        "receipt always decides what was paid. If one clearly resembles this clip, cite it in similar_past_case.\n"
        + "\n".join(lines)
    )


def refs(chosen: list[Feedback]) -> list[MemoryRef]:
    return [MemoryRef(incident_id=f.incident_id, decision=f.decision, reason=f.reason, reviewed_at=f.reviewed_at)
            for f in chosen]


def version(chosen: list[Feedback]) -> str:
    """Part of the cache key: new feedback on a camera gives a fresh analysis instead of an old cached one."""
    h = hashlib.sha256()
    for f in chosen:
        h.update(f"{f.incident_id}|{f.decision}|{f.reason}|{f.reviewed_at}".encode())
    return h.hexdigest()[:16] if chosen else ""
