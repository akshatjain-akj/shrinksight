"""Remembers Gemini models that are out of quota, so later requests start on a backup straight away.

A per-minute 429 rests the model for Gemini's own "retry after" (at least 60 s); a used-up daily quota rests it until
the free tier resets at midnight Pacific time. Kept in the shared cache, so every Cloud Run instance sees it.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime, timedelta, timezone

from .gemini import GeminiUnavailable
from .repo import Repo

MIN_REST_S = 60


def _pacific():
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo("America/Los_Angeles")
    except Exception:  # no tz database in the image: UTC-7 resets at most an hour early (harmless: one more 429)
        return timezone(timedelta(hours=-7))


def _next_reset(now: float) -> float:
    local = datetime.fromtimestamp(now, UTC).astimezone(_pacific())
    midnight = (local + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return midnight.timestamp()


def _key(model: str) -> str:
    return f"quota:{model}"


def rest(repo: Repo, model: str, exc: GeminiUnavailable, now: float | None = None) -> float:
    """Marks `model` as out of quota after a 429; returns when it can be tried again (epoch seconds)."""
    now = time.time() if now is None else now
    until = _next_reset(now) if exc.daily else now + max(MIN_REST_S, exc.retry_after or 0)
    try:
        repo.cache_put(_key(model), {"model": model, "until": until, "daily": exc.daily})
    except Exception:  # noqa: BLE001 - a bookkeeping failure must never break an investigation
        pass
    return until


def resting_until(repo: Repo, model: str, now: float | None = None) -> float | None:
    now = time.time() if now is None else now
    try:
        doc = repo.cache_get(_key(model)) or {}
    except Exception:  # noqa: BLE001
        return None
    until = float(doc.get("until") or 0)
    return until if until > now else None


def usable(repo: Repo, models: list[str], now: float | None = None) -> list[str]:
    """The chain without resting models. If every model is resting, the full chain (one of them may be back)."""
    chain = [m for m in models if resting_until(repo, m, now) is None]
    return chain or list(models)
