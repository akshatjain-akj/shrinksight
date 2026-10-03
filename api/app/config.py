import os
from dataclasses import dataclass, field

# Free-tier friendly default: Flash Lite has the highest daily quota (see docs/PLAN.md).
DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite"


def _env(name: str, default: str = "") -> str:
    value = os.environ.get(name, "").strip()
    return value or default


@dataclass(frozen=True)
class Settings:
    version: str = field(default_factory=lambda: _env("APP_VERSION", "dev"))
    gcp_project: str = field(default_factory=lambda: _env("GCP_PROJECT", _env("GOOGLE_CLOUD_PROJECT")))
    evidence_bucket: str = field(default_factory=lambda: _env("EVIDENCE_BUCKET"))
    gemini_api_key: str = field(default_factory=lambda: _env("GEMINI_API_KEY"))
    gemini_model: str = field(default_factory=lambda: _env("GEMINI_MODEL", DEFAULT_GEMINI_MODEL))
    gemini_timeout_ms: int = 20_000
    # Minimum seconds between live Gemini self-test calls (protects the free-tier quota).
    gemini_selftest_cooldown_s: int = 60
    cors_origins: tuple[str, ...] = field(
        default_factory=lambda: tuple(o for o in _env("CORS_ORIGINS").split(",") if o)
    )


def get_settings() -> Settings:
    return Settings()
