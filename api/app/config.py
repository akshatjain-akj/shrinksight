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
    max_clip_bytes: int = 25 * 1024 * 1024
    # Bigger clips go through the Gemini Files API (uploaded once, deleted after) instead of inline bytes,
    # because inline data is base64-encoded and requests have a total size limit.
    inline_clip_bytes: int = 14 * 1024 * 1024
    clip_fps: int = 5
    # Longer clips are sampled a little less densely to keep Gemini's processing time down
    long_clip_seconds: float = 10
    long_clip_fps: int = 3
    agent_max_tool_calls: int = 4
    # Whole-investigation budget. Firebase Hosting drops forwarded requests after ~60 s, so stay well inside it.
    agent_deadline_s: int = 50
    # "Ask about this incident" agent budget (text only, so much faster)
    ask_deadline_s: int = 25
    # Backup models tried in order when the main one is overloaded (503) or rate limited (429)
    fallback_models: tuple[str, ...] = field(
        default_factory=lambda: tuple(
            m.strip()
            for m in _env("GEMINI_FALLBACK_MODELS", "gemini-3.1-flash-lite,gemini-2.5-flash-lite").split(",")
            if m.strip()
        )
    )
    # The item-pile inventory runs on its own model so it doesn't use the main model's daily quota
    inventory_model: str = field(default_factory=lambda: _env("GEMINI_INVENTORY_MODEL", "gemini-3.1-flash-lite"))
    inventory_deadline_s: int = 20
    # Fixed sampling seed: the same clip gives the same answer more often (0 = let Gemini choose)
    gemini_seed: int = field(default_factory=lambda: _env_int("GEMINI_SEED", 7))
    # Gemini 3+ thinking level for investigations: MINIMAL, LOW, MEDIUM, HIGH, or DEFAULT
    thinking_level: str = field(default_factory=lambda: _env("GEMINI_THINKING_LEVEL", "LOW"))
    # Past manager decisions on the same camera added to each investigation prompt (0 turns the memory off)
    memory_examples: int = field(default_factory=lambda: _env_int("MEMORY_EXAMPLES", 5))
    # Edge auto-tuning: how many edge alerts (since the last change) are needed before the gate is adjusted
    edge_tune_min_alerts: int = field(default_factory=lambda: _env_int("EDGE_TUNE_MIN_ALERTS", 8))
    edge_tune_window: int = 10
    max_scanner_photo_bytes: int = 300_000

    # Abuse / quota protection
    per_ip_per_minute: int = field(default_factory=lambda: _env_int("PER_IP_PER_MINUTE", 6))
    daily_investigations: int = field(default_factory=lambda: _env_int("DAILY_INVESTIGATIONS", 40))
    daily_rule_compiles: int = field(default_factory=lambda: _env_int("DAILY_RULE_COMPILES", 100))
    daily_zone_suggestions: int = field(default_factory=lambda: _env_int("DAILY_ZONE_SUGGESTIONS", 30))
    daily_layout_saves: int = field(default_factory=lambda: _env_int("DAILY_LAYOUT_SAVES", 200))
    daily_questions: int = field(default_factory=lambda: _env_int("DAILY_QUESTIONS", 60))
    daily_inventories: int = field(default_factory=lambda: _env_int("DAILY_INVENTORIES", 120))
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
