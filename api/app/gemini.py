"""Thin gateway over the google-genai SDK.

Everything that talks to Gemini goes through `Gateway.generate`, which adds:
- a time budget: each call's timeout is capped by the caller's deadline, and retries only happen if they can
  still finish in time;
- retries with jittered backoff that honour Gemini's own "retry after" hint;
- small `GenResult` objects, so tests can swap in a fake gateway with scripted results.

`call_with_fallback` moves to the next free model when one is overloaded or rate limited.
"""

import io
import json
import random
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

RETRYABLE_CODES = {429, 500, 502, 503, 504}
# Fast failures where another model is worth trying: overloaded, rate limited, server trouble, or not available.
# Not timeouts: a slow model has used the time a backup would need.
FALLBACK_CODES = {404, 429, 500, 502, 503, 504}
# The Gemini API rejects requests whose deadline is under 10 s; keep a little headroom.
MIN_REQUEST_MS = 10_000
MIN_CALL_SECONDS = 12


class GeminiUnavailable(Exception):
    """Gemini could not be reached after retries (quota, outage or timeout).

    For a 429, `daily` says the model's daily quota is used up (it resets at midnight Pacific time) and `retry_after`
    is Gemini's own "retry after" hint in seconds, when it gave one.
    """

    def __init__(self, message: str, code: int | None = None, daily: bool = False, retry_after: float | None = None):
        super().__init__(message)
        self.code = code
        self.daily = daily
        self.retry_after = retry_after


@dataclass
class FunctionCall:
    name: str
    args: dict[str, Any]


@dataclass
class GenResult:
    text: str = ""
    function_calls: list[FunctionCall] = field(default_factory=list)
    # The model's turn, appended verbatim to the conversation (keeps thought signatures intact)
    content: Any = None
    # Tokens this call used: input, output, thinking, total (empty if Gemini didn't say)
    usage: dict[str, int] = field(default_factory=dict)


@dataclass
class UploadedFile:
    name: str
    uri: str
    mime_type: str


class Gateway(Protocol):
    def generate(
        self,
        model: str,
        contents: list,
        config: Any,
        deadline: float | None = None,
        retries: int | None = None,
        timeout_ms: int | None = None,
    ) -> GenResult: ...
    def upload_video(self, data: bytes, mime: str, timeout_s: float = 60) -> UploadedFile: ...
    def delete_file(self, name: str) -> None: ...
    def check_model(self, model: str) -> tuple[bool, str]: ...


def seconds_left(deadline: float | None) -> float:
    return float("inf") if deadline is None else deadline - time.monotonic()


def thinking_config(types, model: str, level: str):
    """Low thinking keeps investigations fast. Only Gemini 3+ takes a thinking level; others keep their default."""
    level = (level or "").strip().upper()
    if not level or level == "DEFAULT" or not re.match(r"^gemini-(3|[4-9])", model):
        return None
    member = getattr(types.ThinkingLevel, level, None)
    return types.ThinkingConfig(thinking_level=member) if member is not None else None


class GeminiGateway:
    def __init__(self, api_key: str, timeout_ms: int, max_retries: int = 2):
        if not api_key:
            raise GeminiUnavailable("GEMINI_API_KEY is not configured")
        from google import genai
        from google.genai import types

        self._types = types
        self._timeout_ms = timeout_ms
        self._client = genai.Client(api_key=api_key, http_options=types.HttpOptions(timeout=timeout_ms))
        self._max_retries = max_retries

    def generate(
        self,
        model: str,
        contents: list,
        config: Any,
        deadline: float | None = None,
        retries: int | None = None,
        timeout_ms: int | None = None,
    ) -> GenResult:
        from google.genai import errors

        retries = self._max_retries if retries is None else retries
        attempt = 0
        while True:
            left = seconds_left(deadline)
            if left < MIN_CALL_SECONDS:
                raise GeminiUnavailable("Ran out of time waiting for Gemini.", 408)
            cap_ms = timeout_ms or (self._timeout_ms if deadline is None else int((left - 1) * 1000))
            call_ms = int(min(cap_ms, (left - 1) * 1000)) if deadline is not None else cap_ms
            call_ms = max(MIN_REQUEST_MS, call_ms)
            call_config = config.model_copy(update={"http_options": self._types.HttpOptions(timeout=call_ms)})
            try:
                response = self._client.models.generate_content(model=model, contents=contents, config=call_config)
                return _to_result(response)
            except errors.APIError as exc:
                code = getattr(exc, "code", None)
                hint = _retry_after(exc)
                daily = code == 429 and _daily_quota(exc)
                # A used-up daily quota won't come back in seconds: no retry, let the caller switch models now.
                if code not in RETRYABLE_CODES or attempt >= retries or daily:
                    raise GeminiUnavailable(_friendly(code, str(exc)), code, daily, hint) from exc
                wait = hint or (min(4.0, 1.5 * 2**attempt) + random.uniform(0, 0.6))
                # Only wait if a retry can still finish inside the budget; otherwise let the caller fall back.
                if wait > seconds_left(deadline) - 8:
                    raise GeminiUnavailable(_friendly(code, str(exc)), code, daily, hint) from exc
            except Exception as exc:
                if _is_timeout(exc):
                    # Don't retry a slow model: hand back so the caller can try a backup in the time left.
                    raise GeminiUnavailable(
                        f"Gemini took too long to answer (over {call_ms / 1000:.0f} s).", 408
                    ) from exc
                if attempt >= retries or seconds_left(deadline) < 10:
                    raise GeminiUnavailable(f"Couldn't reach Gemini ({type(exc).__name__}).", 502) from exc
                wait = 1.0 + random.uniform(0, 0.5)
            attempt += 1
            time.sleep(wait)

    def upload_video(self, data: bytes, mime: str, timeout_s: float = 60) -> UploadedFile:
        """Uploads a large clip via the Files API and waits until Gemini has processed it."""
        try:
            config = self._types.UploadFileConfig(mime_type=mime)
            uploaded = self._client.files.upload(file=io.BytesIO(data), config=config)
            deadline = time.monotonic() + timeout_s
            while uploaded.state and uploaded.state.name == "PROCESSING":
                if time.monotonic() > deadline:
                    raise GeminiUnavailable("Gemini took too long to process the uploaded clip.", 408)
                time.sleep(1.0)
                uploaded = self._client.files.get(name=uploaded.name)
        except GeminiUnavailable:
            raise
        except Exception as exc:
            raise GeminiUnavailable(f"Uploading the clip to Gemini failed: {type(exc).__name__}") from exc
        if uploaded.state and uploaded.state.name == "FAILED":
            raise GeminiUnavailable("Gemini couldn't process this video file. Try MP4 (H.264).")
        return UploadedFile(name=uploaded.name, uri=uploaded.uri, mime_type=uploaded.mime_type or mime)

    def delete_file(self, name: str) -> None:
        try:
            self._client.files.delete(name=name)
        except Exception:
            pass  # files expire on their own after 48 h; deletion is best effort

    def check_model(self, model: str) -> tuple[bool, str]:
        """Whether this key can use the model. A metadata lookup only; it uses no generation quota."""
        try:
            found = self._client.models.get(model=model)
            return True, getattr(found, "display_name", None) or model
        except Exception as exc:
            code = getattr(exc, "code", None)
            return False, "not available on this key" if code in (403, 404) else f"check failed ({type(exc).__name__})"


def call_with_fallback(
    gateway: Gateway,
    models: list[str],
    contents: list,
    config_for: Callable[[str], Any],
    deadline: float | None = None,
    retries: int = 1,
    on_switch: Callable[[str], None] | None = None,
) -> tuple[GenResult, str]:
    """Tries each model in order; moves on when one is overloaded, rate limited or unavailable."""
    last: GeminiUnavailable | None = None
    for index, model in enumerate(models):
        if index and on_switch:
            on_switch(model)
        try:
            return gateway.generate(model, contents, config_for(model), deadline=deadline, retries=retries), model
        except GeminiUnavailable as exc:
            last = exc
            if exc.code not in FALLBACK_CODES or seconds_left(deadline) < MIN_CALL_SECONDS:
                raise
    raise last or GeminiUnavailable("No Gemini model is configured.")


def model_chain(primary: str, fallbacks: tuple[str, ...]) -> list[str]:
    chain: list[str] = []
    for model in (primary, *fallbacks):
        if model and model not in chain:
            chain.append(model)
    return chain


def _is_timeout(exc: Exception) -> bool:
    name = type(exc).__name__.lower()
    return "timeout" in name or isinstance(exc, TimeoutError)


def _retry_after(exc: Exception) -> float | None:
    """Seconds Gemini asked us to wait (Retry-After header or RetryInfo.retryDelay), if any."""
    try:
        header = exc.response.headers.get("retry-after")  # type: ignore[attr-defined]
        if header:
            return float(header)
    except Exception:
        pass
    try:
        details = json.dumps(getattr(exc, "details", None) or {})
        match = re.search(r'"retryDelay":\s*"(\d+(?:\.\d+)?)s"', details)
        if match:
            return float(match.group(1))
    except Exception:
        pass
    return None


def _daily_quota(exc: Exception) -> bool:
    """True when a 429 is the per-day quota (quotaId ...PerDay...), not the per-minute rate limit."""
    try:
        text = f"{exc} {json.dumps(getattr(exc, 'details', None) or {}, default=str)}"
    except Exception:
        text = str(exc)
    return "PerDay" in text or "per day" in text.lower()


def _to_result(response: Any) -> GenResult:
    calls = [FunctionCall(name=c.name, args=dict(c.args or {})) for c in (response.function_calls or [])]
    content = response.candidates[0].content if response.candidates else None
    try:
        text = response.text or ""
    except ValueError:  # no text parts (e.g. function call only)
        text = ""
    return GenResult(text=text, function_calls=calls, content=content, usage=usage_of(response))


def usage_of(response: Any) -> dict[str, int]:
    meta = getattr(response, "usage_metadata", None)
    if meta is None:
        return {}
    return {
        "input": int(getattr(meta, "prompt_token_count", None) or 0),
        "output": int(getattr(meta, "candidates_token_count", None) or 0),
        "thinking": int(getattr(meta, "thoughts_token_count", None) or 0),
        "total": int(getattr(meta, "total_token_count", None) or 0),
    }


def add_usage(total: dict[str, int], usage: dict[str, int]) -> dict[str, int]:
    """Sums token counts across calls and counts the calls."""
    if not usage:
        return total
    out = {key: total.get(key, 0) + usage.get(key, 0) for key in ("input", "output", "thinking", "total")}
    out["calls"] = total.get("calls", 0) + 1
    return out


def _friendly(code: int | None, raw: str) -> str:
    if code == 429:
        return "Gemini free-tier quota reached; please try again in a minute."
    if code == 503:
        return "Gemini is overloaded right now (model busy); please try again in a moment."
    if code == 404:
        return "Configured Gemini model was not found; check GEMINI_MODEL / GEMINI_INVESTIGATOR_MODEL."
    if code in (400, 413):
        return f"Gemini rejected the request: {raw[:200]}"
    return f"Gemini error ({code}): {raw[:200]}"
