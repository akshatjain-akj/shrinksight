import os
from dataclasses import dataclass, field

# Free-tier friendly default: Flash Lite has the highest daily quota (see docs/PLAN.md).
DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite"


def _env(name: str, default: str = "") -> str:
    value = os.environ.get(name, "").strip()
    return value or default


def _env_int(name: str, default: int) -> int:
    raw = _env(name)
    return int(raw) if raw.isdigit() else default


@dataclass(frozen=True)
class Settings:
    version: str = field(default_factory=lambda: _env("APP_VERSION", "dev"))
    gcp_project: str = field(default_factory=lambda: _env("GCP_PROJECT", _env("GOOGLE_CLOUD_PROJECT")))
    evidence_bucket: str = field(default_factory=lambda: _env("EVIDENCE_BUCKET"))
    gemini_api_key: str = field(default_factory=lambda: _env("GEMINI_API_KEY"))
    # Used for rule compiling and the self-test
    gemini_model: str = field(default_factory=lambda: _env("GEMINI_MODEL", DEFAULT_GEMINI_MODEL))
    # Used for clip investigations (switch to a Flash model for hero runs)
    investigator_model: str = field(
        default_factory=lambda: _env("GEMINI_INVESTIGATOR_MODEL", _env("GEMINI_MODEL", DEFAULT_GEMINI_MODEL))
    )
    gemini_timeout_ms: int = 25_000
    gemini_max_retries: int = 2
    # Minimum seconds between live Gemini self-test calls (protects the free-tier quota).
    gemini_selftest_cooldown_s: int = 60

    # Investigation limits
    max_clip_bytes: int = 15 * 1024 * 1024
    clip_fps: int = 5
    agent_max_tool_calls: int = 4
    agent_deadline_s: int = 45

    # Abuse / quota protection
    per_ip_per_minute: int = field(default_factory=lambda: _env_int("PER_IP_PER_MINUTE", 6))
    daily_investigations: int = field(default_factory=lambda: _env_int("DAILY_INVESTIGATIONS", 40))
    daily_rule_compiles: int = field(default_factory=lambda: _env_int("DAILY_RULE_COMPILES", 100))
    daily_zone_suggestions: int = field(default_factory=lambda: _env_int("DAILY_ZONE_SUGGESTIONS", 30))
    daily_layout_saves: int = field(default_factory=lambda: _env_int("DAILY_LAYOUT_SAVES", 200))
    max_frame_bytes: int = 2 * 1024 * 1024

    # "firestore" on Cloud Run; "memory" for local runs without Google credentials (data resets on restart)
    repo_backend: str = field(default_factory=lambda: _env("REPO_BACKEND", "firestore"))
    # Turn on only after a reCAPTCHA site key is set in the Firebase console.
    app_check_enforce: bool = field(
        default_factory=lambda: _env("APP_CHECK_ENFORCE").lower() in {"1", "true", "yes"}
    )

    currency: str = "INR"
    cors_origins: tuple[str, ...] = field(
        default_factory=lambda: tuple(o.strip() for o in _env("CORS_ORIGINS").split(",") if o.strip())
    )


def get_settings() -> Settings:
    return Settings()
