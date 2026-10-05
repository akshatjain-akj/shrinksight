import asyncio
import base64
import binascii
import json
import uuid
from datetime import UTC, datetime
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, ValidationError, field_validator

from . import selftest
from .agent import ask as ask_agent
from .clips import SIGNED_URL_MINUTES, object_for, sign_seed_clip
from .config import Settings, get_settings
from .gemini import Gateway, GeminiGateway, GeminiUnavailable
from .inventory import take_inventory
from .investigator import investigate, normalise_mime
from .models import (
    POSITIVE_VERDICTS,
    CameraLayout,
    InventoryItem,
    ReceiptLine,
    Rule,
    RuleSpec,
    Transaction,
    ZoneHint,
    validate_rule_spec,
    validate_zone_hints,
)
from .repo import FirestoreRepo, MemoryRepo, Repo
from .rules_compiler import compile_rule
from .seed import STORE_NAME
from .zones import suggest_zones

settings = get_settings()

app = FastAPI(title="ShrinkSight API", docs_url="/api/docs", openapi_url="/api/openapi.json")
app.state.settings = settings
app.state.repo = None
app.state.gateway = None
app.state.clip_signer = None

if settings.cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_methods=["GET", "POST", "PATCH"],
        allow_headers=["content-type", "x-shrinksight-meta", "x-firebase-appcheck"],
    )


# ---------- dependencies (overridable in tests via app.state) ----------
def get_repo() -> Repo:
    if app.state.repo is None:
        app.state.repo = MemoryRepo() if settings.repo_backend == "memory" else FirestoreRepo(settings.gcp_project)
    repo = app.state.repo
    repo.ensure_seeded()
    return repo


def get_gateway() -> Gateway:
    if app.state.gateway is None:
        try:
            app.state.gateway = GeminiGateway(
                settings.gemini_api_key, settings.gemini_timeout_ms, settings.gemini_max_retries
            )
        except GeminiUnavailable as exc:
            raise HTTPException(503, str(exc)) from exc
    return app.state.gateway


def cfg() -> Settings:
    return app.state.settings


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    return forwarded.split(",")[0].strip() or (request.client.host if request.client else "unknown")


def enforce_limits(request: Request, repo: Repo, daily_key: str, daily_limit: int) -> None:
    now = datetime.now(UTC)
    ip = _client_ip(request).replace("/", "_")
    if repo.incr(f"ip-{ip}-{now:%Y%m%d%H%M}", ttl_s=120) > cfg().per_ip_per_minute:
        raise HTTPException(429, "Too many requests from your connection. Please wait a minute.",
                            headers={"Retry-After": "60"})
    if repo.incr(f"day-{daily_key}-{now:%Y%m%d}", ttl_s=2 * 86400) > daily_limit:
        raise HTTPException(429, "Today's free AI quota for this demo is used up. Please try again tomorrow.",
                            headers={"Retry-After": "3600"})


def _now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------- health ----------
@app.get("/api/healthz")
def healthz() -> dict:
    """Cheap liveness probe: no external calls. Also used to wake a scaled-to-zero instance."""
    return {
        "ok": True,
        "service": "shrinksight-api",
        "version": settings.version,
        "model": settings.gemini_model,
        "investigator_model": settings.investigator_model,
    }


@app.get("/api/selftest")
async def run_selftest() -> dict:
    """Checks every cloud dependency in parallel and reports each one separately."""
    firestore_res, storage_res, gemini_res, models_res = await asyncio.gather(
        asyncio.to_thread(selftest.check_firestore, settings),
        asyncio.to_thread(selftest.check_storage, settings),
        asyncio.to_thread(selftest.check_gemini, settings),
        asyncio.to_thread(selftest.check_models, settings),
    )
    checks = {"firestore": firestore_res, "storage": storage_res, "gemini": gemini_res, "models": models_res}
    return {"ok": all(c["ok"] for c in checks.values()), "version": settings.version, "checks": checks}


# ---------- store ----------
@app.get("/api/store")
def store() -> dict:
    repo = get_repo()
    return {
        "name": STORE_NAME,
        "currency": cfg().currency,
        "cameras": [c.model_dump() for c in repo.cameras()],
        "zones": [z.model_dump() for z in repo.zones()],
    }


@app.get("/api/transactions")
def transactions(lane_id: str | None = Query(default=None, max_length=10)) -> list[dict]:
    txns = [t for t in get_repo().transactions(lane_id) if t.source == "seed"]
    return [{**t.model_dump(), "total_inr": t.total_inr} for t in txns]


# ---------- clips ----------
@app.get("/api/clips/{camera_id}")
def clip_url(camera_id: str) -> dict:
    """A 15-minute HTTPS URL for a demo clip. Unknown cameras have no stored video."""
    if object_for(camera_id) is None:
        raise HTTPException(404, "No clip for this camera")
    signer = getattr(app.state, "clip_signer", None)
    try:
        url = signer(camera_id) if signer else sign_seed_clip(cfg(), camera_id)
    except Exception as exc:
        raise HTTPException(503, "Could not sign the clip URL") from exc
    return {"camera_id": camera_id, "url": url, "expires_in": SIGNED_URL_MINUTES * 60}


# ---------- camera zone layouts ----------
def _camera_or_404(repo: Repo, camera_id: str):
    camera = next((c for c in repo.cameras() if c.id == camera_id), None)
    if camera is None:
        raise HTTPException(404, "Unknown camera")
    return camera


@app.get("/api/layouts")
def layouts() -> dict:
    """Saved zone layouts for every camera, keyed by camera id. Cameras never marked are absent."""
    return {camera_id: layout.model_dump() for camera_id, layout in get_repo().layouts().items()}


class LayoutIn(BaseModel):
    zones: list[ZoneHint] = Field(max_length=8)


@app.put("/api/layouts/{camera_id}")
def save_layout(camera_id: str, body: LayoutIn, request: Request) -> dict:
    repo = get_repo()
    camera = _camera_or_404(repo, camera_id)
    problems = validate_zone_hints(body.zones, camera, repo.zones())
    if problems:
        raise HTTPException(400, " ".join(problems))
    enforce_limits(request, repo, "layouts", cfg().daily_layout_saves)
    layout = CameraLayout(camera_id=camera.id, zones=body.zones, updated_at=_now_iso())
    repo.save_layout(layout)
    return layout.model_dump()


IMAGE_MIME = {"image/jpeg": "image/jpeg", "image/png": "image/png"}


@app.post("/api/layouts/{camera_id}/suggest")
async def suggest_layout(camera_id: str, request: Request) -> dict:
    """Body: one JPEG/PNG frame from the camera. Gemini suggests where each zone of this camera is."""
    enforce_app_check(request)
    mime = IMAGE_MIME.get(request.headers.get("content-type", "").split(";")[0].strip().lower())
    if mime is None:
        raise HTTPException(415, "Send a JPEG or PNG frame.")
    repo = await asyncio.to_thread(get_repo)
    camera = await asyncio.to_thread(_camera_or_404, repo, camera_id)
    await asyncio.to_thread(enforce_limits, request, repo, "zones", cfg().daily_zone_suggestions)
    image = await _read_clip(request, cfg().max_frame_bytes)
    gateway = get_gateway()
    try:
        suggestions, cached = await asyncio.to_thread(
            suggest_zones, image, mime, camera, repo.zones(), gateway, cfg().gemini_model, repo, cfg().fallback_models
        )
    except GeminiUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    return {"camera_id": camera.id, "zones": [s.model_dump() for s in suggestions], "cached": cached}


# ---------- item-pile inventory ----------
INVENTORY_VIEWS = ("pile", "left", "right")


@app.post("/api/inventory")
async def inventory(request: Request) -> dict:
    """Multipart 'view' JPEGs named pile/left/right; header x-shrinksight-meta {camera_id}. Lists the pile's items."""
    enforce_app_check(request)
    meta = _parse_meta(request.headers.get("x-shrinksight-meta"))
    repo = await asyncio.to_thread(get_repo)
    camera = await asyncio.to_thread(_camera_or_404, repo, meta.camera_id)
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > len(INVENTORY_VIEWS) * STILL_LIMIT + 64 * 1024:
        raise HTTPException(413, "Inventory images are too large")
    await asyncio.to_thread(enforce_limits, request, repo, "inventory", cfg().daily_inventories)
    form = await request.form(max_files=len(INVENTORY_VIEWS), max_fields=len(INVENTORY_VIEWS))
    views: list[tuple[str, bytes]] = []
    for item in form.getlist("view"):
        label = (getattr(item, "filename", "") or "").rsplit(".", 1)[0]
        if not hasattr(item, "read") or label not in INVENTORY_VIEWS:
            continue
        data = await item.read()
        if data.startswith(b"\xff\xd8") and len(data) <= STILL_LIMIT:
            views.append((label, data))
    if not any(label == "pile" for label, _ in views):
        raise HTTPException(400, "Send at least the 'pile' view")
    views.sort(key=lambda v: INVENTORY_VIEWS.index(v[0]))
    try:
        items, model, cached = await asyncio.to_thread(take_inventory, views, camera, get_gateway(), cfg(), repo)
    except GeminiUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    return {"items": [i.model_dump() for i in items], "model": model, "cached": cached}


# ---------- incidents ----------
@app.get("/api/incidents")
def incidents(limit: int = Query(default=50, ge=1, le=100)) -> list[dict]:
    return [i.model_dump() for i in get_repo().incidents(limit)]


@app.get("/api/incidents/{incident_id}")
def incident(incident_id: str) -> dict:
    found = get_repo().get_incident(incident_id)
    if found is None:
        raise HTTPException(404, "Incident not found")
    return found.model_dump()


class ReviewIn(BaseModel):
    decision: Literal["confirm", "dismiss"]


@app.post("/api/incidents/{incident_id}/review")
def review(incident_id: str, body: ReviewIn) -> dict:
    repo = get_repo()
    found = repo.get_incident(incident_id)
    if found is None:
        raise HTTPException(404, "Incident not found")
    found.status = "RESOLVED_CONFIRMED" if body.decision == "confirm" else "RESOLVED_DISMISSED"
    found.reviewed_at = _now_iso()
    repo.save_incident(found)
    return found.model_dump()


class AskIn(BaseModel):
    question: str = Field(min_length=3, max_length=240)


@app.post("/api/incidents/{incident_id}/ask")
def ask_incident(incident_id: str, body: AskIn, request: Request) -> dict:
    """A Gemini agent answers a question about this incident, calling store-data tools as needed."""
    enforce_app_check(request)
    repo = get_repo()
    found = repo.get_incident(incident_id)
    if found is None:
        raise HTTPException(404, "Incident not found")
    enforce_limits(request, repo, "questions", cfg().daily_questions)
    try:
        result = ask_agent(body.question, found, repo, get_gateway(), cfg())
    except GeminiUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    return {"answer": result.answer, "steps": result.steps, "model": result.model}


@app.get("/api/stats")
def stats() -> dict:
    items = get_repo().incidents(100)
    flagged = [i for i in items if i.verdict.verdict in POSITIVE_VERDICTS and i.status != "RESOLVED_DISMISSED"]
    return {
        "investigated": len(items),
        "flagged": len(flagged),
        "false_alarms_rejected": sum(1 for i in items if i.status == "REJECTED"),
        "needs_review": sum(1 for i in items if i.status == "NEEDS_REVIEW"),
        "est_loss_caught_inr": round(sum(i.est_loss_inr for i in flagged), 2),
    }


# ---------- rules ----------
@app.get("/api/rules")
def rules() -> list[dict]:
    return [r.model_dump() for r in get_repo().rules()]


class CompileIn(BaseModel):
    text: str = Field(min_length=5, max_length=300)


@app.post("/api/rules/compile")
def rules_compile(body: CompileIn, request: Request) -> dict:
    enforce_app_check(request)
    repo = get_repo()
    enforce_limits(request, repo, "compile", cfg().daily_rule_compiles)
    try:
        result = compile_rule(
            body.text, repo.zones(), get_gateway(), cfg().gemini_model, repo, cfg().fallback_models
        )
    except GeminiUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    return {"spec": result.spec.model_dump(), "problems": result.problems, "cached": result.cached}


class RuleIn(BaseModel):
    source_text: str = Field(min_length=5, max_length=300)
    spec: RuleSpec


@app.post("/api/rules", status_code=201)
def rules_create(body: RuleIn) -> dict:
    repo = get_repo()
    problems = validate_rule_spec(body.spec, {z.id: z for z in repo.zones()})
    if problems:
        raise HTTPException(400, " ".join(problems))
    rule = Rule(id=f"rule-{uuid.uuid4().hex[:10]}", source_text=body.source_text, spec=body.spec,
                created_at=_now_iso())
    repo.save_rule(rule)
    return rule.model_dump()


class RulePatch(BaseModel):
    enabled: bool


@app.patch("/api/rules/{rule_id}")
def rules_patch(rule_id: str, body: RulePatch) -> dict:
    repo = get_repo()
    rule = repo.get_rule(rule_id)
    if rule is None:
        raise HTTPException(404, "Rule not found")
    rule.enabled = body.enabled
    repo.save_rule(rule)
    return rule.model_dump()


# ---------- investigate ----------
class Tier1EventIn(BaseModel):
    t: str = Field(max_length=16)
    kind: str = Field(max_length=40)
    score: float = Field(ge=0, le=1)
    detail: str = Field(default="", max_length=240)
    camera_id: str | None = Field(default=None, max_length=40)
    trigger: str | None = Field(default=None, max_length=20)
    confidence: float | None = Field(default=None, ge=0, le=1)
    box: list[int] | None = Field(default=None, max_length=4)

    @field_validator("trigger")
    @classmethod
    def known_trigger(cls, value: str | None) -> str | None:
        if value is not None and value not in {"hot_score", "lane_leave"}:
            raise ValueError("trigger must be hot_score or lane_leave")
        return value

    @field_validator("box")
    @classmethod
    def box_range(cls, value: list[int] | None) -> list[int] | None:
        if value is None:
            return None
        if len(value) != 4 or any(n < 0 or n > 1000 for n in value):
            raise ValueError("box must be four integers in 0..1000")
        return value


class InvestigateMeta(BaseModel):
    camera_id: str = Field(max_length=40)
    transaction_id: str | None = Field(default=None, max_length=40)
    receipt: list[ReceiptLine] | None = Field(default=None, max_length=30)
    tier1_events: list[Tier1EventIn] = Field(default_factory=list, max_length=12)
    clip_seconds: float | None = Field(default=None, ge=0, le=600)
    # The item list confirmed in the browser (from the inventory call, possibly edited). Tracked one by one.
    inventory: list[InventoryItem] | None = Field(default=None, max_length=30)
    # When the browser cropped the video to the action area: [ymin, xmin, ymax, xmax] of the full view, 0-1000.
    video_crop: list[int] | None = Field(default=None, min_length=4, max_length=4)

    @field_validator("video_crop")
    @classmethod
    def crop_range(cls, value: list[int] | None) -> list[int] | None:
        if value is None:
            return None
        if not all(0 <= n <= 1000 for n in value) or value[2] - value[0] < 50 or value[3] - value[1] < 50:
            raise ValueError("video_crop must be [ymin, xmin, ymax, xmax] within 0..1000 and at least 50 wide")
        return value
    # Zones marked for this clip. None = use the camera's saved layout; [] = send no zones.
    zones: list[ZoneHint] | None = Field(default=None, max_length=8)


def enforce_app_check(request: Request) -> None:
    """Requires the header only when APP_CHECK_ENFORCE is set. Token verification needs the console key."""
    if not cfg().app_check_enforce:
        return
    if not request.headers.get("x-firebase-appcheck"):
        raise HTTPException(401, "App Check token missing. Refresh the page and try again.")


def _parse_meta(header: str | None) -> InvestigateMeta:
    if not header:
        raise HTTPException(400, "Missing x-shrinksight-meta header")
    try:
        raw = base64.urlsafe_b64decode(header + "=" * (-len(header) % 4))
        return InvestigateMeta.model_validate(json.loads(raw))
    except (binascii.Error, ValueError, ValidationError) as exc:
        raise HTTPException(400, "Invalid x-shrinksight-meta header") from exc


# Time-ordered stills, then zone close-ups (sent by the Investigate page when zones are marked).
STILL_LABELS = ("before", "reach", "hold", "after", "pickup_start", "scanner_mid", "bagging_end")
MAX_STILLS = len(STILL_LABELS)
STILL_LIMIT = 400_000  # the high-detail item-pile close-up can be up to ~1024 px wide


async def _read_marked(request: Request, limit: int) -> tuple[bytes, str, list[tuple[str, bytes]]]:
    # Reject oversized uploads before parsing: clip + 4 stills + form overhead.
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit + MAX_STILLS * STILL_LIMIT + 64 * 1024:
        raise HTTPException(413, f"Clip too large (max {limit // (1024 * 1024)} MB)")
    form = await request.form(max_files=MAX_STILLS + 1, max_fields=MAX_STILLS + 1)
    upload = form.get("clip")
    if upload is None or not hasattr(upload, "read"):
        raise HTTPException(400, "Missing clip")
    mime = normalise_mime(getattr(upload, "content_type", "") or "")
    if mime is None:
        raise HTTPException(415, "Unsupported video type. Use MP4, WebM or MOV.")
    clip = await upload.read()
    if not clip:
        raise HTTPException(400, "Empty clip")
    if len(clip) > limit:
        raise HTTPException(413, f"Clip too large (max {limit // (1024 * 1024)} MB)")
    stills: list[tuple[str, bytes]] = []
    for item in form.getlist("still"):
        if not hasattr(item, "read") or len(stills) >= MAX_STILLS:
            continue
        label = (getattr(item, "filename", "") or "").rsplit(".", 1)[0]
        if label not in STILL_LABELS:
            continue
        data = await item.read()
        if len(data) > STILL_LIMIT or not data.startswith(b"\xff\xd8"):
            continue
        stills.append((label, data))
    order = {label: index for index, label in enumerate(STILL_LABELS)}
    stills.sort(key=lambda item: order[item[0]])
    return clip, mime, stills


async def _read_clip(request: Request, limit: int) -> bytes:
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise HTTPException(413, f"Clip too large (max {limit // (1024 * 1024)} MB)")
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise HTTPException(413, f"Clip too large (max {limit // (1024 * 1024)} MB)")
        chunks.append(chunk)
    if size == 0:
        raise HTTPException(400, "Empty clip")
    return b"".join(chunks)


@app.post("/api/investigate")
async def investigate_clip(request: Request) -> StreamingResponse:
    """Body: the raw video bytes. Header x-shrinksight-meta: base64url JSON InvestigateMeta.

    Responds with Server-Sent Events: `progress` events, then one `result` or `error`.
    """
    enforce_app_check(request)
    content_type = request.headers.get("content-type", "")
    marked = content_type.startswith("multipart/form-data")
    mime = "video/webm" if marked else normalise_mime(content_type)
    if mime is None:
        raise HTTPException(415, "Unsupported video type. Use MP4, WebM or MOV.")
    meta = _parse_meta(request.headers.get("x-shrinksight-meta"))

    repo = await asyncio.to_thread(get_repo)
    camera = next((c for c in await asyncio.to_thread(repo.cameras) if c.id == meta.camera_id), None)
    if camera is None:
        raise HTTPException(400, "Unknown camera")

    transaction = None
    if camera.kind == "checkout":
        if meta.receipt:
            transaction = Transaction(id=f"TXN-LIVE-{uuid.uuid4().hex[:8]}", lane_id=camera.lane_id or "",
                                      lines=meta.receipt, started_at=_now_iso(), source="live")
        elif meta.transaction_id:
            transaction = await asyncio.to_thread(repo.get_transaction, meta.transaction_id)
            if transaction is None:
                raise HTTPException(400, "Unknown transaction")

    if meta.zones is None:
        saved = await asyncio.to_thread(repo.get_layout, camera.id)
        zones = saved.zones if saved else []
    else:
        zones = meta.zones
        problems = validate_zone_hints(zones, camera, await asyncio.to_thread(repo.zones))
        if problems:
            raise HTTPException(400, " ".join(problems))

    await asyncio.to_thread(enforce_limits, request, repo, "investigate", cfg().daily_investigations)
    if marked:
        clip, mime, stills = await _read_marked(request, cfg().max_clip_bytes)
    else:
        clip = await _read_clip(request, cfg().max_clip_bytes)
        stills = []
    gateway = get_gateway()
    if transaction is not None and transaction.source == "live":
        await asyncio.to_thread(repo.save_transaction, transaction)

    def events():
        for event in investigate(
            clip, mime, camera, transaction, repo, gateway, cfg(),
            tier1_events=[e.model_dump() for e in meta.tier1_events],
            stills=stills,
            zones=zones,
            clip_seconds=meta.clip_seconds,
            inventory=meta.inventory,
            video_crop=meta.video_crop,
        ):
            yield f"event: {event['type']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


@app.exception_handler(GeminiUnavailable)
async def _gemini_unavailable(_: Request, exc: GeminiUnavailable) -> JSONResponse:
    return JSONResponse(status_code=503, content={"detail": str(exc)})
