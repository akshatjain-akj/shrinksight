"""Thin gateway over the google-genai SDK.

Everything that talks to Gemini goes through `Gateway.generate`, which adds retries with
exponential backoff and returns a small `GenResult`. Tests swap in a fake gateway that returns
scripted `GenResult`s, so agent logic is tested without network or quota.
"""

import io
import random
import time
from dataclasses import dataclass, field
from typing import Any, Protocol

RETRYABLE_CODES = {408, 429, 500, 502, 503, 504}


class GeminiUnavailable(Exception):
    """Gemini could not be reached after retries (quota, outage or timeout)."""

    def __init__(self, message: str, code: int | None = None):
        super().__init__(message)
        self.code = code


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


@dataclass
class UploadedFile:
    name: str
    uri: str
    mime_type: str


class Gateway(Protocol):
    def generate(self, model: str, contents: list, config: Any) -> GenResult: ...
    def upload_video(self, data: bytes, mime: str) -> UploadedFile: ...
    def delete_file(self, name: str) -> None: ...


class GeminiGateway:
    def __init__(self, api_key: str, timeout_ms: int, max_retries: int = 2):
        if not api_key:
            raise GeminiUnavailable("GEMINI_API_KEY is not configured")
        from google import genai
        from google.genai import types

        self._types = types
        self._client = genai.Client(api_key=api_key, http_options=types.HttpOptions(timeout=timeout_ms))
        self._max_retries = max_retries

    def generate(self, model: str, contents: list, config: Any) -> GenResult:
        from google.genai import errors

        attempt = 0
        while True:
            try:
                response = self._client.models.generate_content(model=model, contents=contents, config=config)
                return _to_result(response)
            except errors.APIError as exc:
                code = getattr(exc, "code", None)
                if code not in RETRYABLE_CODES or attempt >= self._max_retries:
                    raise GeminiUnavailable(_friendly(code, str(exc)), code) from exc
            except Exception as exc:  # network errors / timeouts from the HTTP layer
                if attempt >= self._max_retries:
                    raise GeminiUnavailable(f"Gemini request failed: {type(exc).__name__}") from exc
            attempt += 1
            time.sleep(min(8.0, 2**attempt) + random.uniform(0, 0.5))


    def upload_video(self, data: bytes, mime: str, timeout_s: float = 60) -> UploadedFile:
        """Uploads a large clip via the Files API and waits until Gemini has processed it."""
        try:
            config = self._types.UploadFileConfig(mime_type=mime)
            uploaded = self._client.files.upload(file=io.BytesIO(data), config=config)
            deadline = time.monotonic() + timeout_s
            while uploaded.state and uploaded.state.name == "PROCESSING":
                if time.monotonic() > deadline:
                    raise GeminiUnavailable("Gemini took too long to process the uploaded clip.")
                time.sleep(1.5)
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


def _to_result(response: Any) -> GenResult:
    calls = [FunctionCall(name=c.name, args=dict(c.args or {})) for c in (response.function_calls or [])]
    content = response.candidates[0].content if response.candidates else None
    try:
        text = response.text or ""
    except ValueError:  # no text parts (e.g. function call only)
        text = ""
    return GenResult(text=text, function_calls=calls, content=content)


def _friendly(code: int | None, raw: str) -> str:
    if code == 429:
        return "Gemini free-tier quota reached; please try again in a minute."
    if code == 404:
        return "Configured Gemini model was not found; check GEMINI_MODEL / GEMINI_INVESTIGATOR_MODEL."
    if code in (400, 413):
        return f"Gemini rejected the request: {raw[:200]}"
    return f"Gemini error ({code}): {raw[:200]}"
