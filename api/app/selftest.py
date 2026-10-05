"""Setup self-test: proves Cloud Run can reach Firestore, Cloud Storage and Gemini.

Each check returns {"ok", "detail", "ms"} and never raises, so one broken component
doesn't hide the status of the others. Google client libraries are imported lazily
to keep cold starts fast.
"""

import time
from datetime import UTC, datetime
from typing import Any

from .config import Settings

CheckResult = dict[str, Any]


def _timed(fn) -> CheckResult:
    start = time.perf_counter()
    try:
        detail = fn()
        ok = True
    except Exception as exc:  # report, don't crash: this is a diagnostics endpoint
        detail = f"{type(exc).__name__}: {exc}"[:300]
        ok = False
    return {"ok": ok, "detail": detail, "ms": round((time.perf_counter() - start) * 1000)}


def check_firestore(settings: Settings) -> CheckResult:
    def run() -> str:
        from google.cloud import firestore

        db = firestore.Client(project=settings.gcp_project or None)
        ref = db.collection("selftest").document("ping")
        ref.set({"at": firestore.SERVER_TIMESTAMP, "version": settings.version})
        if not ref.get().exists:
            raise RuntimeError("write succeeded but read-back found no document")
        return "write + read OK"

    return _timed(run)


def check_storage(settings: Settings) -> CheckResult:
    def run() -> str:
        if not settings.evidence_bucket:
            raise RuntimeError("EVIDENCE_BUCKET not set")
        from google.cloud import storage

        blob = storage.Client(project=settings.gcp_project or None).bucket(settings.evidence_bucket).blob(
            "selftest/ping.txt"
        )
        blob.upload_from_string(datetime.now(UTC).isoformat(), content_type="text/plain")
        blob.download_as_bytes()
        return f"write + read OK (gs://{settings.evidence_bucket})"

    return _timed(run)


def _call_gemini(settings: Settings) -> str:
    from google import genai
    from google.genai import types

    client = genai.Client(
        api_key=settings.gemini_api_key,
        http_options=types.HttpOptions(timeout=settings.gemini_timeout_ms),
    )
    response = client.models.generate_content(
        model=settings.gemini_model,
        contents="Reply with exactly the word: OK",
    )
    return f"{settings.gemini_model} replied: {(response.text or '').strip()[:40]!r}"


def check_gemini(settings: Settings) -> CheckResult:
    """Live Gemini call, rate-limited via a Firestore timestamp so a public URL can't drain quota."""

    def run() -> str:
        if not settings.gemini_api_key:
            raise RuntimeError("GEMINI_API_KEY not set")
        cache_ref = None
        try:
            from google.cloud import firestore

            db = firestore.Client(project=settings.gcp_project or None)
            cache_ref = db.collection("selftest").document("gemini")
            cached = cache_ref.get()
            if cached.exists:
                data = cached.to_dict() or {}
                age = time.time() - data.get("epoch", 0)
                if age < settings.gemini_selftest_cooldown_s:
                    return f"{data.get('detail')} (cached {int(age)}s ago)"
        except Exception:
            cache_ref = None  # Firestore problems are reported by their own check

        detail = _call_gemini(settings)
        if cache_ref is not None:
            cache_ref.set({"epoch": time.time(), "detail": detail})
        return detail

    return _timed(run)


def check_models(settings: Settings) -> CheckResult:
    """Confirms the main and backup models exist for this key (metadata lookups only, no generation quota)."""

    def run() -> str:
        if not settings.gemini_api_key:
            raise RuntimeError("GEMINI_API_KEY not set")
        from .gemini import GeminiGateway, model_chain

        gateway = GeminiGateway(settings.gemini_api_key, settings.gemini_timeout_ms, 0)
        chain = model_chain(settings.investigator_model, settings.fallback_models)
        results = [(m, *gateway.check_model(m)) for m in chain]
        summary = " · ".join(f"{'✓' if ok else '✗'} {m}" + ("" if ok else f" ({detail})") for m, ok, detail in results)
        if not all(ok for _, ok, _ in results):
            raise RuntimeError(summary)
        return summary

    return _timed(run)
